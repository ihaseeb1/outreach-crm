import { NextResponse } from "next/server";
import { z } from "zod";

import { copyName } from "@/campaigns/duplicate";
import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import type { Campaign, SequenceStep } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ id: z.string().uuid() });

/**
 * Copies a campaign's setup: name, schedule settings, chosen mailboxes and the
 * whole sequence.
 *
 * Enrolments are deliberately **not** copied. A duplicate exists to send the
 * same sequence to a different list; carrying the old list over would re-enrol
 * people who have already had this exact sequence — and for anyone mid-flight
 * it would mean two campaigns emailing them at once.
 *
 * The copy always starts as a draft, so nothing goes out before the new list is
 * loaded and the schedule checked.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A campaign id is required." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const [{ data: sourceRow }, { data: nameRows }] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, name, mailbox_ids, settings")
      .eq("id", parsed.data.id)
      .eq("workspace_id", session.workspace.id)
      .maybeSingle(),
    supabase
      .from("campaigns")
      .select("name")
      .eq("workspace_id", session.workspace.id),
  ]);

  const source = sourceRow as Pick<
    Campaign,
    "id" | "name" | "mailbox_ids" | "settings"
  > | null;
  if (!source) {
    return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  }

  const name = copyName(
    source.name,
    ((nameRows ?? []) as { name: string }[]).map((row) => row.name),
  );

  const { data: created, error: createError } = await supabase
    .from("campaigns")
    .insert({
      workspace_id: session.workspace.id,
      name,
      status: "draft",
      created_by: session.userId,
      mailbox_ids: source.mailbox_ids ?? [],
      settings: source.settings ?? {},
    })
    .select("id")
    .single();

  if (createError || !created) {
    return NextResponse.json(
      { error: createError?.message ?? "Could not duplicate the campaign." },
      { status: 500 },
    );
  }

  const campaignId = (created as { id: string }).id;

  const { data: stepRows } = await supabase
    .from("sequence_steps")
    .select("step_number, delay_days, subject_template, body_template, reply_to_thread")
    .eq("campaign_id", source.id)
    .order("step_number", { ascending: true });

  const steps = (stepRows ?? []) as Pick<
    SequenceStep,
    | "step_number"
    | "delay_days"
    | "subject_template"
    | "body_template"
    | "reply_to_thread"
  >[];

  if (steps.length > 0) {
    const { error: stepError } = await supabase
      .from("sequence_steps")
      .insert(steps.map((step) => ({ campaign_id: campaignId, ...step })));

    // A campaign with no sequence looks identical to one whose steps just
    // failed to save, and starting it would send nothing. Undo instead.
    if (stepError) {
      await supabase
        .from("campaigns")
        .delete()
        .eq("id", campaignId)
        .eq("workspace_id", session.workspace.id);
      return NextResponse.json(
        { error: `Could not copy the sequence: ${stepError.message}` },
        { status: 500 },
      );
    }
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "campaign.duplicated",
    entityType: "campaign",
    entityId: campaignId,
    meta: { name, source_id: source.id, steps: steps.length },
  });

  return NextResponse.json({ ok: true, id: campaignId, name, steps: steps.length });
}
