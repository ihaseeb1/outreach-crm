import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runCampaignBatch } from "@/campaigns/run";
import { syncSuppressedCampaignContacts } from "@/campaigns/enroll";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Sends the next due sequence step for a batch of campaign contacts. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  // Default raised from 10 so the per-tick budget stops being the throughput
  // cap: every mailbox with a due contact gets its one paced send each tick,
  // instead of ten sends being shared across the whole pool. Each mailbox is
  // still limited to one send per its own rest gap — nothing bursts — and the
  // batch's own time guard keeps a big budget from overrunning the function.
  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "40",
    10,
  );

  const supabase = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();

  // Clear out anything that has been suppressed since it was queued, then send.
  const { stopped } = await syncSuppressedCampaignContacts(supabase, { limit: 200 });
  const result = await runCampaignBatch(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 60) : 40,
  });

  // Heartbeat: this is the send dispatcher, so its freshness is what "nothing
  // is sending" is measured against.
  await recordWorkerRun(supabase, {
    job: "campaigns",
    ok: true,
    processed: result.sent,
    skipped: result.skipped,
    failed: result.failed,
    notes: result.notes,
    startedAt,
  });

  return jobResponse({
    job: "campaigns",
    processed: result.sent,
    skipped: result.skipped,
    failed: result.failed,
    details: {
      completed: result.completed,
      stopped: result.stopped,
      suppressedRemoved: stopped,
      notes: result.notes,
    },
  });
}

export const POST = GET;
