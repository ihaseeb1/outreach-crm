import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runLeadBatch } from "@/leads/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Processes one pending client-acquisition lead run per tick.
 *
 * Like discovery, this supplements the local worker (`npm run worker`) rather
 * than replacing it: keyless engines are blocked from datacenter IPs, so a
 * keyless run is left for the worker and this cron only advances runs when a
 * cloud engine is configured. Deploy-safe before migration 0021 — runLeadBatch
 * returns early when the lead_runs table is absent.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();

  const result = await runLeadBatch(supabase, { limit: 1 });

  await recordWorkerRun(supabase, {
    job: "leads",
    ok: true,
    processed: result.runsProcessed,
    startedAt,
  });

  return jobResponse({
    job: "leads",
    processed: result.runsProcessed,
    details: { sitesFound: result.sitesFound },
  });
}

export const POST = GET;
