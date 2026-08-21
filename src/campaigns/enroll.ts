import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import {
  describeExclusions,
  loadEnrolments,
  summariseByCampaign,
  type EnrolmentElsewhere,
} from "@/campaigns/exclusions";
import { suppressedSubset } from "@/mail/suppressions";
import { isSendableStatus } from "@/validation/validate";
import { nextSendAt, resolveWindow } from "@/campaigns/schedule";
import type { Campaign, Contact } from "@/types/db";

export interface EnrollResult {
  added: number;
  skippedSuppressed: number;
  skippedUnvalidated: number;
  /** Already in *this* campaign. */
  alreadyEnrolled: number;
  /** Already in some other campaign, so not added again. */
  skippedOtherCampaign: number;
  /** Which campaigns those were, biggest first. */
  otherCampaigns: { campaign: string; count: number }[];
}

/**
 * Adds contacts to a campaign.
 *
 * Suppressed addresses are refused at enrolment as well as at send time — no
 * point queueing work that canSend() will reject, and it keeps the campaign's
 * numbers honest.
 *
 * A contact enrolled in **any** campaign is refused too, and the campaign
 * holding it is named. This is not the same check as "already in this
 * campaign": that one only ever looked at the campaign being added to, which is
 * how a new campaign could be handed 100 contacts that were all already being
 * emailed by another one. Whatever the other enrolment's status is — pending,
 * mid-sequence, completed, bounced — the person has been used, and a second
 * campaign writing to them again is the duplicate being avoided.
 *
 * `allowInOtherCampaigns` is the deliberate override, for the case where
 * re-contacting from a different angle is the actual intent.
 */
export async function enrollContacts(
  supabase: SupabaseClient,
  campaign: Campaign,
  contactIds: string[],
  options: { actorId?: string | null; allowInOtherCampaigns?: boolean } = {},
): Promise<EnrollResult> {
  const result: EnrollResult = {
    added: 0,
    skippedSuppressed: 0,
    skippedUnvalidated: 0,
    alreadyEnrolled: 0,
    skippedOtherCampaign: 0,
    otherCampaigns: [],
  };
  if (contactIds.length === 0) return result;

  // Read in chunks: `in` goes into the query string, and this is called with up
  // to five thousand ids, which is a URL no gateway will accept.
  const contacts: Pick<Contact, "id" | "email" | "validation_status">[] = [];
  const CHUNK = 200;

  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const { data: contactRows } = await supabase
      .from("contacts")
      .select("id, email, validation_status")
      .eq("workspace_id", campaign.workspace_id)
      .in("id", contactIds.slice(i, i + CHUNK));

    contacts.push(
      ...((contactRows ?? []) as Pick<
        Contact,
        "id" | "email" | "validation_status"
      >[]),
    );
  }

  if (contacts.length === 0) return result;

  const suppressed = await suppressedSubset(
    supabase,
    campaign.workspace_id,
    contacts.map((contact) => contact.email),
  );

  // Every campaign in the workspace, not just this one — see the note above.
  const enrolments = await loadEnrolments(supabase, campaign.workspace_id, {
    contactIds: contacts.map((contact) => contact.id),
  });

  const window = resolveWindow(campaign.settings);
  const now = new Date();

  const rows = [];
  const blockedBy: EnrolmentElsewhere[][] = [];

  for (const contact of contacts) {
    const enrolled = enrolments.get(contact.id) ?? [];

    if (enrolled.some((entry) => entry.campaignId === campaign.id)) {
      result.alreadyEnrolled += 1;
      continue;
    }

    const elsewhere = enrolled.filter((entry) => entry.campaignId !== campaign.id);
    if (elsewhere.length > 0 && !options.allowInOtherCampaigns) {
      result.skippedOtherCampaign += 1;
      blockedBy.push(elsewhere);
      continue;
    }
    if (suppressed.has(contact.email.toLowerCase())) {
      result.skippedSuppressed += 1;
      continue;
    }
    if (!isSendableStatus(contact.validation_status)) {
      result.skippedUnvalidated += 1;
      continue;
    }

    rows.push({
      campaign_id: campaign.id,
      contact_id: contact.id,
      workspace_id: campaign.workspace_id,
      current_step: 0,
      status: "pending",
      // Step 1 goes out at the next window opening, scattered so a fresh import
      // does not fire as one visible block.
      next_send_at: nextSendAt({ from: now, delayDays: 0, window }).toISOString(),
    });
  }

  result.otherCampaigns = summariseByCampaign(blockedBy);

  if (rows.length > 0) {
    const { error } = await supabase
      .from("campaign_contacts")
      .upsert(rows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    result.added = rows.length;
  }

  await logActivity(supabase, {
    workspaceId: campaign.workspace_id,
    actorId: options.actorId ?? null,
    action: "campaign.contacts_enrolled",
    entityType: "campaign",
    entityId: campaign.id,
    meta: {
      ...result,
      // Spelled out in the log as well as returned, so "why did adding 100
      // contacts add nothing" is answerable months later.
      excluded_summary: describeExclusions(result.otherCampaigns),
      allow_reuse: Boolean(options.allowInOtherCampaigns),
    },
  });

  return result;
}

/**
 * Safety net: stops any queued contact whose address has since landed on the
 * suppression list by another route (manual add, unsubscribe on a different
 * campaign, bounce recorded elsewhere).
 *
 * canSend() would refuse these anyway — this just stops them clogging the
 * queue and keeps campaign counts truthful.
 */
export async function syncSuppressedCampaignContacts(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<{ stopped: number }> {
  const limit = options.limit ?? 200;

  let query = supabase
    .from("campaign_contacts")
    .select("id, workspace_id, contact_id, contacts!inner(email)")
    .in("status", ["pending", "active"])
    .limit(limit);

  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  const rows = (data ?? []) as unknown as {
    id: string;
    workspace_id: string;
    contact_id: string;
    contacts: { email: string } | { email: string }[];
  }[];
  if (rows.length === 0) return { stopped: 0 };

  const emailOf = (row: (typeof rows)[number]): string =>
    Array.isArray(row.contacts) ? (row.contacts[0]?.email ?? "") : row.contacts.email;

  const byWorkspace = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspace_id) ?? [];
    list.push(row);
    byWorkspace.set(row.workspace_id, list);
  }

  let stopped = 0;
  for (const [workspaceId, group] of byWorkspace) {
    const suppressed = await suppressedSubset(
      supabase,
      workspaceId,
      group.map(emailOf),
    );
    const ids = group
      .filter((row) => suppressed.has(emailOf(row).toLowerCase()))
      .map((row) => row.id);

    if (ids.length === 0) continue;

    await supabase
      .from("campaign_contacts")
      .update({
        status: "unsubscribed",
        next_send_at: null,
        paused_reason: "Address is on the suppression list",
      })
      .in("id", ids);

    stopped += ids.length;
  }

  return { stopped };
}
