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
 * Vercel's Hobby plan only allows a couple of once-a-day crons, which is far
 * too coarse for outreach. So this one endpoint runs a slice of each job and
 * is designed to be polled every few minutes by any free scheduler
 * (cron-job.org, GitHub Actions, Cloudflare Worker cron, or Vercel Cron on Pro).
 *
 * Every job is a bounded, idempotent batch — overlapping ticks are safe.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const supabase = createSupabaseAdminClient();
  const started = Date.now();
  const results: Record<string, unknown> = {};

  results.scrape = await safely("scrape", () =>
    runScrapeBatch(supabase, { limit: 5 }),
  );
  results.validate = await safely("validate", () =>
    runValidationBatch(supabase, { limit: 100 }),
  );
  results.inbound = await safely("inbound", () =>
    runInboundPoll(supabase, { limit: 3 }),
  );
  results.suppressionSync = await safely("suppressionSync", () =>
    syncSuppressedCampaignContacts(supabase, { limit: 200 }),
  );
  results.campaigns = await safely("campaigns", () =>
    runCampaignBatch(supabase, { limit: 10 }),
  );
  results.warmup = await safely("warmup", () =>
    runWarmupBatch(supabase, { sendLimit: 4 }),
  );
  // Skips any mailbox already checked today, so calling it every tick is cheap.
  results.health = await safely("health", () =>
    runHealthChecks(supabase, { limit: 3 }),
  );

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - started,
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
