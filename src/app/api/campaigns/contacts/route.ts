import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { enrollContacts } from "@/campaigns/enroll";
import {
  describeExclusions,
  loadEnrolments,
  mergeSummaries,
  summariseByCampaign,
  type EnrolmentElsewhere,
  type EnrolmentIndex,
} from "@/campaigns/exclusions";
import type { Campaign } from "@/types/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  campaign_id: z.string().uuid(),
  /** Either explicit ids, or a filter matching the Contacts page. */
  contact_ids: z.array(z.string().uuid()).max(5000).optional(),
  filter: z
    .object({
      validation_status: z.string().optional(),
      domain: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    })
    .optional(),
  /** Deliberately re-contact people another campaign has already used. */
  allow_in_other_campaigns: z.boolean().optional(),
});

/**
 * How many contacts to read while looking for unused ones.
 *
 * "Add 100" has to mean 100 *new* contacts, so the search cannot stop at the
 * first 100 rows — in a workspace where the newest few hundred are all enrolled
 * already it would find none and report nothing wrong. It pages until it has
 * enough or until this ceiling, which is reported back so a silent stop is
 * impossible.
 */
const MAX_SCAN = 20_000;
const SCAN_PAGE = 1000;

/** Enrols contacts into a campaign, refusing suppressed and unvalidated ones. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", parsed.data.campaign_id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!campaignRow) {
    return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  }
  const campaign = campaignRow as Campaign;

  const allowReuse = parsed.data.allow_in_other_campaigns === true;
  let contactIds = parsed.data.contact_ids ?? [];
  let scanned = 0;
  let scanExhausted = false;
  let skippedAlreadyUsed = 0;
  /** The enrolments that ruled a candidate out, so they can be named. */
  const blockedBy: EnrolmentElsewhere[][] = [];

  if (contactIds.length === 0) {
    const filter = parsed.data.filter ?? {};
    const wanted = filter.limit ?? 500;

    // Which contacts any campaign has already taken. Read once, up front:
    // filtering the candidate query on it is impossible (the id list would be
    // longer than a URL allows), so the pages are filtered in memory instead.
    const used: EnrolmentIndex = allowReuse
      ? new Map()
      : await loadEnrolments(supabase, session.workspace.id);

    const fresh: string[] = [];

    for (let from = 0; from < MAX_SCAN && fresh.length < wanted; from += SCAN_PAGE) {
      let query = supabase
        .from("contacts")
        .select("id")
        .eq("workspace_id", session.workspace.id)
        .order("created_at", { ascending: false })
        .range(from, from + SCAN_PAGE - 1);

      // Default to only addresses that passed validation.
      if (filter.validation_status) {
        query = query.eq("validation_status", filter.validation_status);
      } else {
        query = query.in("validation_status", ["valid", "role_account"]);
      }
      if (filter.domain) query = query.ilike("domain", `%${filter.domain}%`);
      if (filter.q) query = query.ilike("email", `%${filter.q}%`);

      const { data } = await query;
      const page = ((data ?? []) as { id: string }[]).map((row) => row.id);
      scanned += page.length;

      for (const id of page) {
        if (fresh.length >= wanted) break;
        const enrolled = used.get(id);
        if (enrolled && enrolled.length > 0) {
          skippedAlreadyUsed += 1;
          blockedBy.push(enrolled);
          continue;
        }
        fresh.push(id);
      }

      if (page.length < SCAN_PAGE) {
        scanExhausted = true;
        break;
      }
    }

    contactIds = fresh;

    if (contactIds.length === 0) {
      return NextResponse.json(
        {
          error:
            skippedAlreadyUsed > 0
              ? `No new contacts. All ${skippedAlreadyUsed} matching contact${
                  skippedAlreadyUsed === 1 ? " is" : "s are"
                } already in a campaign (${describeExclusions(
                  summariseByCampaign(blockedBy),
                )}) — tick "allow contacts already in other campaigns" to add them anyway.`
              : "No matching contacts.",
          skippedAlreadyUsed,
          scanned,
        },
        { status: 400 },
      );
    }
  }

  if (contactIds.length === 0) {
    return NextResponse.json({ error: "No matching contacts." }, { status: 400 });
  }

  try {
    const result = await enrollContacts(supabase, campaign, contactIds, {
      actorId: session.userId,
      allowInOtherCampaigns: allowReuse,
    });
    return NextResponse.json({
      ok: true,
      ...result,
      // The filter path drops used contacts before enrolment even sees them, so
      // its exclusions are counted here and added to the ones enrolment found.
      skippedOtherCampaign: result.skippedOtherCampaign + skippedAlreadyUsed,
      otherCampaigns: mergeSummaries(
        result.otherCampaigns,
        summariseByCampaign(blockedBy),
      ),
      scanned,
      scanExhausted: scanned >= MAX_SCAN && !scanExhausted,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** Removes a contact from a campaign (or stops it, keeping the history). */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("campaign_contacts")
    .update({ status: "paused", next_send_at: null, paused_reason: "Removed manually" })
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
