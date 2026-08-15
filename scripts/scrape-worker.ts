/**
 * Long-lived dynamic-scraping worker.
 *
 * Run this on any always-on box (Hostinger VPS, a home server, a Raspberry Pi)
 * when you need JavaScript-rendered sites scraped. It talks to the same Supabase
 * database as the app and uses the same batch runner — the only difference is
 * that it passes the Playwright scraper instead of the static one.
 *
 *   npm install playwright
 *   npx playwright install --with-deps chromium
 *   npx tsx scripts/scrape-worker.ts
 *
 * Environment: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the
 * SCRAPER_* settings. Stop it with Ctrl-C; it finishes the current batch first.
 */

import { createClient } from "@supabase/supabase-js";

import { PlaywrightScraper } from "../src/scraper/playwright-scraper";
import { runScrapeBatch } from "../src/scraper/run";

const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 5);
const IDLE_DELAY_MS = Number(process.env.WORKER_IDLE_DELAY_MS ?? 30_000);
const BUSY_DELAY_MS = Number(process.env.WORKER_BUSY_DELAY_MS ?? 2_000);

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the worker.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const scraper = new PlaywrightScraper();

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("Finishing the current batch, then stopping…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Dynamic scrape worker started (batch ${BATCH_SIZE}).`);

  while (!stopping) {
    try {
      const result = await runScrapeBatch(supabase, {
        limit: BATCH_SIZE,
        scraper,
      });

      if (result.processed > 0) {
        console.log(
          `Processed ${result.processed} site(s): ${result.contactsCreated} new contacts, ` +
            `${result.skippedRobots} skipped by robots.txt, ${result.failed} failed.`,
        );
      }

      await sleep(result.processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS);
    } catch (error) {
      console.error("Batch failed:", error instanceof Error ? error.message : error);
      await sleep(IDLE_DELAY_MS);
    }
  }

  await scraper.close();
  console.log("Worker stopped.");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
