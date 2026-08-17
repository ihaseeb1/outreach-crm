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

  // Cheap-and-consequential first, expensive last.
  //
  // Inbound polling was ordered ahead of sending on the reasoning that a reply
  // should be seen before the next follow-up. In practice IMAP takes ~25s per
  // mailbox, so it consumed the entire budget and campaigns were deferred on
  // every single tick — sending never ran at all. Starving the send loop is far
  // worse than a follow-up occasionally going out in the ten minutes before a
  // reply is noticed, especially as follow-up steps are days apart.
  //
  // Two mailboxes per inbound tick, polled at the same time rather than one
  // after the other, so the step still fits its 22s slice. The parallel
  // per-job endpoints are the real poller; this single-call fallback stays
  // deliberately small.
  await step("suppressionSync", 3_000, () =>
    syncSuppressedCampaignContacts(supabase, { limit: 200 }),
  );
  await step("campaigns", 12_000, () => runCampaignBatch(supabase, { limit: 10 }));
  await step("inbound", 22_000, () =>
    runInboundPoll(supabase, { limit: 2, concurrency: 2, budgetMs: 20_000 }),
  );
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
