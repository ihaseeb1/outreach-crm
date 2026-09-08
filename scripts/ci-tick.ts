/**
 * CI engine tick — runs the background jobs directly on a GitHub Actions runner.
 *
 * A runner is a full Linux VM with no CPU meter and no function timeout, so the
 * engine runs here instead of pinging the Vercel /api/cron/* routes. This is
 * what keeps the CRM working 24/7 without Vercel's Fluid Active CPU cap ever
 * pausing it. The Next.js dashboard stays on Vercel (light); only the
 * background compute moves here.
 *
 *   npx tsx scripts/ci-tick.ts fast   # campaigns, warmup, inbound, health
 *   npx tsx scripts/ci-tick.ts slow   # validate, scrape, backlinks, purge, discovery…
 *
 * One pass, then exit — the Actions schedule re-runs it. Every job is a bounded,
 * idempotent batch (the exact functions the API routes call), so a run that is
 * delayed or skipped simply picks up whatever is due next time, and the per-row
 * claim leases mean two overlapping runs never double-send.
 *
 * Env (from GitHub Secrets): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * APP_ENCRYPTION_KEY, NEXT_PUBLIC_APP_URL, plus any OAuth vars in use.
 * Kill switch: set the repository variable CRON_PAUSED=1 to make every pass a
 * no-op (takes effect on the next run, no redeploy).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { runCampaignBatch } from "../src/campaigns/run";
import { syncSuppressedCampaignContacts } from "../src/campaigns/enroll";
import { runInboundPoll } from "../src/mail/poll";
import { runWarmupBatch } from "../src/warmup/engine";
import { runHealthChecks } from "../src/health/run";
import { runValidationBatch } from "../src/validation/run";
import { runScrapeBatch } from "../src/scraper/run";
import { verifyDueBacklinks } from "../src/deals/verify";
import { runWarmupPurge } from "../src/warmup/purge";
import { runDiscoveryBatch } from "../src/discovery/run";
import { runPublisherCrawlBatch } from "../src/discovery/crawl/run";
import { runEnrichBatch } from "../src/discovery/enrich/run";
import { runLeadBatch } from "../src/leads/run";

// Pick up .env.local for local testing; in Actions the env comes from secrets.
try {
  (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // No .env.local — rely on the ambient environment.
}

/** Runs one job, isolating its failure so the rest of the pass still runs. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(`[ok] ${name} (${Date.now() - startedAt}ms):`, JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fail] ${name} (${Date.now() - startedAt}ms): ${message}`);
  }
}

async function runFastLane(supabase: SupabaseClient): Promise<void> {
  // The live outreach loop. No 60s function budget here, so inbound can cover
  // every mailbox in one pass instead of a few at a time.
  await step("suppressionSync", () =>
    syncSuppressedCampaignContacts(supabase, { limit: 200 }),
  );
  await step("campaigns", () => runCampaignBatch(supabase, { limit: 60 }));
  await step("warmup", () => runWarmupBatch(supabase));
  await step("inbound", () =>
    runInboundPoll(supabase, {
      limit: 50,
      concurrency: 6,
      budgetMs: 120_000,
      includeInactive: true,
    }),
  );
  await step("health", () => runHealthChecks(supabase, { limit: 10 }));
}

async function runSlowLane(supabase: SupabaseClient): Promise<void> {
  // Heavier, non-time-critical jobs. Best-effort: any whose migration is not yet
  // applied throws and is logged by step(), exactly as the API routes tolerate.
  await step("validate", () => runValidationBatch(supabase, { limit: 200 }));
  await step("scrape", () => runScrapeBatch(supabase, { limit: 25 }));
  await step("backlinks", () => verifyDueBacklinks(supabase, { limit: 20 }));
  await step("warmup-purge", () =>
    runWarmupPurge(supabase, { dryRun: false, mailboxLimit: 3 }),
  );
  await step("discovery", () => runDiscoveryBatch(supabase, { limit: 2 }));
  await step("publishers", () => runPublisherCrawlBatch(supabase, { limit: 3 }));
  await step("enrich", () => runEnrichBatch(supabase, { limit: 10 }));
  await step("leads", () => runLeadBatch(supabase, { limit: 2 }));
}

async function main(): Promise<void> {
  const lane = process.argv[2] === "slow" ? "slow" : "fast";

  if (process.env.CRON_PAUSED === "1") {
    console.log(`CRON_PAUSED=1 — ${lane} lane skipped.`);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`ci-tick ${lane} lane @ ${new Date().toISOString()}`);
  if (lane === "fast") {
    await runFastLane(supabase);
  } else {
    await runSlowLane(supabase);
  }
  console.log("ci-tick done.");
}

void main();
