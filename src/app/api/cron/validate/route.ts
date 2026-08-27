import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runValidationBatch } from "@/validation/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Validates a batch of contacts still marked `unknown`. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "150",
    10,
  );

  const supabase = createSupabaseAdminClient();
  const result = await runValidationBatch(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 500) : 150,
  });

  await recordWorkerRun(supabase, {
    job: "validate",
    ok: true,
    processed: result.processed,
    skipped: result.deferred,
  });

  return jobResponse({
    job: "validate",
    processed: result.processed,
    details: {
      valid: result.valid,
      invalid: result.invalid,
      suppressed: result.suppressed,
      removed: result.removed,
      queued_for_power: result.queuedForPower,
      deferred: result.deferred,
    },
  });
}

export const POST = GET;
