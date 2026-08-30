import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { readDeletionSettings } from "@/warmup/deletion";
import { runWarmupPurge } from "@/warmup/purge";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Warmup deletion controls for the Mailboxes page: turn auto-deletion on/off,
 * set retention, and run a cleanup on demand (for the existing backlog, without
 * waiting for the daily tick). Admin-only, because it removes mail.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    enabled: z.boolean().optional(),
    deleteAfter: z.enum(["today", "7d", "14d"]).optional(),
  }),
  z.object({
    action: z.literal("run"),
    /** Preview only — report what would be deleted without deleting. */
    dryRun: z.boolean().optional(),
  }),
]);

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.appRole !== "super_admin" && session.appRole !== "admin") {
    return NextResponse.json(
      { error: "Only an admin can change warmup deletion." },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const supabase = createSupabaseAdminClient();
  const workspaceId = session.workspace.id;

  if (parsed.data.action === "configure") {
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle();

    const settings =
      ((workspace as { settings: Record<string, unknown> | null } | null)
        ?.settings as Record<string, unknown> | null) ?? {};
    const current = readDeletionSettings(settings);
    const warmup =
      (settings.warmup as Record<string, unknown> | undefined) ?? {};

    const nextEnabled = parsed.data.enabled ?? current.autoDeleteEnabled;
    const nextRetention = parsed.data.deleteAfter ?? current.deleteAfter;

    const { error } = await supabase
      .from("workspaces")
      .update({
        settings: {
          ...settings,
          warmup: {
            ...warmup,
            auto_delete_enabled: nextEnabled,
            delete_after: nextRetention,
          },
        },
      })
      .eq("id", workspaceId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logActivity(supabase, {
      workspaceId,
      actorId: session.userId,
      action: nextEnabled ? "warmup.deletion_enabled" : "warmup.deletion_disabled",
      meta: { auto_delete_enabled: nextEnabled, delete_after: nextRetention },
    });

    return NextResponse.json({
      ok: true,
      enabled: nextEnabled,
      deleteAfter: nextRetention,
    });
  }

  // action === "run": clean up now. ignoreRotation so a manual run covers every
  // mailbox, not just the one due today; the pool + retention checks are
  // unchanged, so it can only ever remove warmup that is already past retention.
  const result = await runWarmupPurge(supabase, {
    workspaceId,
    dryRun: parsed.data.dryRun === true,
    ignoreRotation: true,
    mailboxLimit: 50,
    budgetMs: 50_000,
  });

  return NextResponse.json({ ok: true, ...result });
}
