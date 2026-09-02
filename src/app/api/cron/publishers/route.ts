import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { runPublisherCrawlBatch } from "@/discovery/crawl/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Crawls a small batch of publishers opted into author-crawling, resolving
 * their recent guest authors' destination sites into active_authors.
 *
 * Like discovery, this is a supplement to the local worker (`npm run worker`) —
 * crawling is slow, so a big site may span several ticks; claims and upserts
 * are idempotent so partial progress is safe. Deploy-safe before migrations
 * 0016/0017: the batch returns early when the tables/columns are absent.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const startedAt = new Date().toISOString();

  const result = await runPublisherCrawlBatch(supabase, { limit: 2 });

  await recordWorkerRun(supabase, {
    job: "publishers",
    ok: true,
    processed: result.sitesProcessed,
    startedAt,
  });

  return jobResponse({
    job: "publishers",
    processed: result.sitesProcessed,
    details: { authorsFound: result.authorsFound },
  });
}

export const POST = GET;
