import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { suppressedSubset } from "@/mail/suppressions";
import { isSendableStatus } from "@/validation/validate";
import { nextSendAt, resolveWindow } from "@/campaigns/schedule";
import type { Campaign, Contact } from "@/types/db";

export interface EnrollResult {
  added: number;
  skippedSuppressed: number;
  skippedUnvalidated: number;
  alreadyEnrolled: number;
}

/**
 * Adds contacts to a campaign.
 *
 * Suppressed addresses are refused at enrolment as well as at send time — no
 * point queueing work that canSend() will reject, and it keeps the campaign's
 * numbers honest.
 */
export async function enrollContacts(
  supabase: SupabaseClient,
  campaign: Campaign,
  contactIds: string[],
  options: { actorId?: string | null } = {},
): Promise<EnrollResult> {
  const result: EnrollResult = {
    added: 0,
    skippedSuppressed: 0,
    skippedUnvalidated: 0,
    alreadyEnrolled: 0,
  };
  if (contactIds.length === 0) return result;

  const { data: contactRows } = await supabase
    .from("contacts")
    .select("id, email, validation_status")
    .eq("workspace_id", campaign.workspace_id)
    .in("id", contactIds);

  const contacts = (contactRows ?? []) as Pick<
    Contact,
    "id" | "email" | "validation_status"
  >[];
  if (contacts.length === 0) return result;

  const suppressed = await suppressedSubset(
    supabase,
    campaign.workspace_id,
    contacts.map((contact) => contact.email),
  );

  const { data: existingRows } = await supabase
    .from("campaign_contacts")
    .select("contact_id")
    .eq("campaign_id", campaign.id)
    .in(
      "contact_id",
      contacts.map((contact) => contact.id),
    );
  const existing = new Set(
    ((existingRows ?? []) as { contact_id: string }[]).map((row) => row.contact_id),
  );

  const window = resolveWindow(campaign.settings);
  const now = new Date();

  const rows = [];
  for (const contact of contacts) {
    if (existing.has(contact.id)) {
      result.alreadyEnrolled += 1;
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
    meta: { ...result },
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
