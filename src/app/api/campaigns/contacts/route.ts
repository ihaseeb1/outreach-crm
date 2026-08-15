import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { enrollContacts } from "@/campaigns/enroll";
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
});

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

  let contactIds = parsed.data.contact_ids ?? [];

  if (contactIds.length === 0) {
    const filter = parsed.data.filter ?? {};
    let query = supabase
      .from("contacts")
      .select("id")
      .eq("workspace_id", session.workspace.id)
      .order("created_at", { ascending: false })
      .limit(filter.limit ?? 500);

    // Default to only addresses that passed validation.
    if (filter.validation_status) {
      query = query.eq("validation_status", filter.validation_status);
    } else {
      query = query.in("validation_status", ["valid", "role_account"]);
    }
    if (filter.domain) query = query.ilike("domain", `%${filter.domain}%`);
    if (filter.q) query = query.ilike("email", `%${filter.q}%`);

    const { data } = await query;
    contactIds = ((data ?? []) as { id: string }[]).map((row) => row.id);
  }

  if (contactIds.length === 0) {
    return NextResponse.json({ error: "No matching contacts." }, { status: 400 });
  }

  try {
    const result = await enrollContacts(supabase, campaign, contactIds, {
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, ...result });
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
