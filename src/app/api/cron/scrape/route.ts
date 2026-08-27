import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runScrapeBatch } from "@/scraper/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Scrapes a small batch of pending websites, then returns. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "8",
    10,
  );

  const supabase = createSupabaseAdminClient();
  const result = await runScrapeBatch(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 25) : 8,
  });

  await recordWorkerRun(supabase, {
    job: "scrape",
    ok: true,
    processed: result.processed,
    skipped: result.skippedRobots,
    failed: result.failed,
  });

  return jobResponse({
    job: "scrape",
    processed: result.processed,
    skipped: result.skippedRobots,
    failed: result.failed,
    details: { contactsCreated: result.contactsCreated },
  });
}

export const POST = GET;
