import { NextResponse } from "next/server";

import { assertCronAuthorized } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCampaignBatch } from "@/campaigns/run";
import { syncSuppressedCampaignContacts } from "@/campaigns/enroll";
import { runHealthChecks } from "@/health/run";
import { runInboundPoll } from "@/mail/poll";
import { runScrapeBatch } from "@/scraper/run";
import { runWarmupBatch } from "@/warmup/engine";
import { runValidationBatch } from "@/validation/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Single dispatcher for every recurring job.
 *
 * Vercel's Hobby plan only allows a once-a-day cron, which is far too coarse for
 * outreach, so this endpoint runs a slice of each job and is polled every 10
 * minutes by the GitHub Actions workflow in .github/workflows/tick.yml.
 *
 * It works to a deadline rather than trying to finish everything. Running all
 * seven jobs unconditionally overran the 60s function limit and the whole tick
 * died with FUNCTION_INVOCATION_TIMEOUT — losing the work of every job that had
 * already succeeded, including sends, because nothing was reported back.
 *
 * Every job is a bounded, idempotent batch, so a job deferred here is simply
 * picked up by the next tick ten minutes later. Finishing and reporting beats
 * attempting everything and returning nothing.
 */

/** Leaves headroom under maxDuration for the response itself. */
const BUDGET_MS = 45_000;

export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const started = Date.now();
  const results: Record<string, unknown> = {};
  const deferred: string[] = [];

  const elapsed = () => Date.now() - started;

  /**
   * Runs a job only if there is plausibly time for it. `reserveMs` is a rough
   * worst case for that job — polling IMAP across mailboxes is far slower than
   * a couple of Postgres queries, and treating them alike would either defer
   * cheap jobs needlessly or start expensive ones too late.
   */
  async function step<T>(
    name: string,
    reserveMs: number,
    fn: () => Promise<T>,
  ): Promise<void> {
    if (elapsed() + reserveMs > BUDGET_MS) {
      deferred.push(name);
      return;
    }
    results[name] = await safely(name, fn);
  }

  // Ordered by consequence, not by cost.
  //
  // Suppression sync first: it is cheap and stops sequences for anyone who
  // opted out. Inbound next, because a reply must be seen before the follow-up
  // goes out — sending step 3 to somebody who already answered is the worst
  // failure this system has. Sending third. Warmup, health, validation and
  // scraping are all safe to slip to a later tick.
  await step("suppressionSync", 3_000, () =>
    syncSuppressedCampaignContacts(supabase, { limit: 200 }),
  );
  await step("inbound", 25_000, () => runInboundPoll(supabase, { limit: 2 }));
  await step("campaigns", 12_000, () => runCampaignBatch(supabase, { limit: 10 }));
  await step("warmup", 15_000, () => runWarmupBatch(supabase, { sendLimit: 3 }));
  // Skips any mailbox already checked today, so calling it every tick is cheap.
  await step("health", 8_000, () => runHealthChecks(supabase, { limit: 3 }));
  await step("validate", 8_000, () => runValidationBatch(supabase, { limit: 50 }));
  await step("scrape", 10_000, () => runScrapeBatch(supabase, { limit: 5 }));

  return NextResponse.json({
    ok: true,
    durationMs: elapsed(),
    deferred,
    results,
  });
}

export const POST = GET;

async function safely<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tick] job ${name} failed: ${message}`);
    return { error: message };
  }
}
