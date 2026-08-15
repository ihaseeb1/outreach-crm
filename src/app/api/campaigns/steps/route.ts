import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  campaign_id: z.string().uuid(),
  steps: z
    .array(
      z.object({
        delay_days: z.number().int().min(0).max(365),
        subject_template: z.string().max(500),
        body_template: z.string().min(1).max(50_000),
        reply_to_thread: z.boolean(),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * Replaces a campaign's sequence wholesale — simplest thing that matches how
 * the editor works, and avoids per-step id juggling in the UI.
 *
 * Contacts already mid-sequence keep their `current_step`, so shortening a
 * sequence completes them rather than re-sending anything.
 */
export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", parsed.data.campaign_id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found." }, { status: 404 });
  }

  // Step 1 must have a subject — later steps may inherit it by threading.
  const first = parsed.data.steps[0];
  if (!first?.subject_template.trim()) {
    return NextResponse.json(
      { error: "Step 1 needs a subject line." },
      { status: 400 },
    );
  }

  for (const [index, step] of parsed.data.steps.entries()) {
    if (index > 0 && !step.reply_to_thread && !step.subject_template.trim()) {
      return NextResponse.json(
        {
          error: `Step ${index + 1} starts a new thread, so it needs its own subject.`,
        },
        { status: 400 },
      );
    }
  }

  await supabase
    .from("sequence_steps")
    .delete()
    .eq("campaign_id", parsed.data.campaign_id);

  const { error } = await supabase.from("sequence_steps").insert(
    parsed.data.steps.map((step, index) => ({
      campaign_id: parsed.data.campaign_id,
      step_number: index + 1,
      delay_days: index === 0 ? 0 : step.delay_days,
      subject_template: step.subject_template,
      body_template: step.body_template,
      reply_to_thread: index === 0 ? false : step.reply_to_thread,
    })),
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, steps: parsed.data.steps.length });
}
