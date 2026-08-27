import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runWarmupBatch } from "@/warmup/engine";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** One tick of the peer warmup loop: ramp, send, engage, rescue, reply. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const result = await runWarmupBatch(supabase, { sendLimit: 5 });

  await recordWorkerRun(supabase, {
    job: "warmup",
    ok: true,
    processed: result.sent,
    skipped: Array.isArray(result.skipped) ? result.skipped.length : 0,
  });

  return jobResponse({
    job: "warmup",
    processed: result.sent,
    details: {
      ramped: result.ramped,
      engaged: result.engaged,
      rescuedFromSpam: result.rescued,
      replied: result.replied,
      skipped: result.skipped,
    },
  });
}

export const POST = GET;
