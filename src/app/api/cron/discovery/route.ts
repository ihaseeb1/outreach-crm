import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runDiscoveryBatch } from "@/discovery/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Processes one pending discovery run per tick.
 *
 * Discovery is heavy (many throttled SERP calls), so this is a supplement to
 * the local worker (`npm run worker`), not a replacement: a run may exceed the
 * 60s function budget and simply resume next tick — the run is claimed
 * pending -> running and results upsert idempotently, so partial progress is
 * safe. For serious throughput run the local worker; this keeps runs moving
 * even when the worker is off.
 *
 * Deploy-safe before migration 0016: runDiscoveryBatch returns early when the
 * discovery_runs table is absent.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();

  const result = await runDiscoveryBatch(supabase, { limit: 1 });

  await recordWorkerRun(supabase, {
    job: "discovery",
    ok: true,
    processed: result.runsProcessed,
    startedAt,
  });

  return jobResponse({
    job: "discovery",
    processed: result.runsProcessed,
    details: { sitesFound: result.sitesFound },
  });
}

export const POST = GET;
