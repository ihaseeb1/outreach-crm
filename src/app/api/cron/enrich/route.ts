import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runEnrichBatch } from "@/discovery/enrich/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Enriches a small batch of active authors: self-scrapes their destination site
 * for a contact email + phone, verifies the email (free, no port 25), and
 * normalizes the phone. Deploy-safe before migration 0018: the batch returns
 * early when the enriched_at column is absent.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();

  const result = await runEnrichBatch(supabase, { limit: 5 });

  await recordWorkerRun(supabase, {
    job: "enrich",
    ok: true,
    processed: result.processed,
    startedAt,
  });

  return jobResponse({
    job: "enrich",
    processed: result.processed,
    details: { withEmail: result.withEmail, verified: result.verified },
  });
}

export const POST = GET;
