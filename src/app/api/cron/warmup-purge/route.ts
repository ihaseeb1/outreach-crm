import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runWarmupPurge } from "@/warmup/purge";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Daily-ish warmup deletion tick.
 *
 * Safe to schedule immediately: it deletes nothing until a workspace sets
 * settings.warmup.auto_delete_enabled = true. Until then it reports what it
 * *would* delete (dry run) so the numbers can be watched before the switch is
 * flipped. Pass ?dryRun=1 to force report-only even when enabled.
 *
 * The DB soft/hard-delete passes are cheap and run every call; the IMAP
 * move-to-Trash pass rotates one mailbox per call by default (mailboxLimit),
 * once a day each, so a half-hourly tick never re-scans the same mailbox.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const mailboxLimit = Number(url.searchParams.get("mailboxes") ?? "1") || 1;

  const supabase = createSupabaseAdminClient();
  const result = await runWarmupPurge(supabase, { dryRun, mailboxLimit });

  await recordWorkerRun(supabase, {
    job: "warmup-purge",
    ok: true,
    processed: result.softDeleted + result.hardDeleted + result.mailboxTrashed,
    skipped: result.skipped.length + result.aborted.length,
    notes: [...result.aborted, ...result.skipped].slice(0, 20),
  });

  return jobResponse({
    job: "warmup-purge",
    processed: result.softDeleted + result.hardDeleted + result.mailboxTrashed,
    details: {
      dryRun: result.dryRun,
      enabledWorkspaces: result.enabledWorkspaces,
      softDeleted: result.softDeleted,
      hardDeleted: result.hardDeleted,
      mailboxTrashed: result.mailboxTrashed,
      mailboxesPurged: result.mailboxesPurged,
      aborted: result.aborted,
      skipped: result.skipped,
    },
  });
}

export const POST = GET;
