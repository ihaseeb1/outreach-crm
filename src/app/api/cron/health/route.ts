import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runHealthChecks } from "@/health/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Daily health check. Safe to call more often than daily — a mailbox already
 * checked today is skipped, so extra ticks cost nothing.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const result = await runHealthChecks(supabase, { limit: 5 });

  return jobResponse({
    job: "health",
    processed: result.checked,
    details: {
      paused: result.paused,
      recovered: result.recovered,
      warnings: result.warnings,
    },
  });
}

export const POST = GET;
