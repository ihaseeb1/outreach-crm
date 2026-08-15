import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mailbox_id: z.string().uuid(),
  enabled: z.boolean().optional(),
  // Kept deliberately conservative: providers detect artificial warmup, and a
  // fast ramp to a high target is the clearest tell there is.
  target_daily_volume: z.number().int().min(1).max(200).optional(),
  ramp_increment: z.number().int().min(1).max(10).optional(),
  reply_rate: z.number().min(0).max(1).optional(),
  current_daily_volume: z.number().int().min(0).max(200).optional(),
});

/** Creates or updates the warmup settings for one mailbox. */
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

  const { data: mailbox } = await supabase
    .from("mailboxes")
    .select("id")
    .eq("id", parsed.data.mailbox_id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!mailbox) {
    return NextResponse.json({ error: "Mailbox not found." }, { status: 404 });
  }

  if (parsed.data.enabled) {
    // Warmup is a loop — one mailbox has nobody to talk to.
    const { count } = await supabase
      .from("mailboxes")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", session.workspace.id)
      .eq("is_active", true);

    if ((count ?? 0) < 2) {
      return NextResponse.json(
        {
          error:
            "Warmup needs at least two connected mailboxes — they warm up by emailing each other.",
        },
        { status: 400 },
      );
    }
  }

  const { mailbox_id, ...patch } = parsed.data;

  const { error } = await supabase.from("warmup_settings").upsert(
    {
      mailbox_id,
      workspace_id: session.workspace.id,
      ...patch,
      ...(patch.enabled ? { started_at: new Date().toISOString() } : {}),
    },
    { onConflict: "mailbox_id" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: patch.enabled === false ? "warmup.disabled" : "warmup.updated",
    entityType: "mailbox",
    entityId: mailbox_id,
    meta: { ...patch },
  });

  return NextResponse.json({ ok: true });
}
