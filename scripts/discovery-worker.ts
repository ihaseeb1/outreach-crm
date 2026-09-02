/**
 * Local discovery worker — run this on your own machine with `npm run worker`.
 *
 * The zero-cost stack does its heavy lifting here rather than in a serverless
 * function: SERP sweeps, publisher crawling and contact enrichment all take far
 * longer than a 60s function budget and would time out. This process has no
 * timeout and is free. It polls the same Supabase database the app writes to,
 * claims a small batch of work each tick, and idles when there is nothing to do.
 *
 *   npm run worker
 *
 * Environment: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY). Stop with Ctrl-C; it
 * finishes the current tick first.
 *
 * Note: this is the free tier's accepted trade-off — search engines rate-limit
 * keyless access, so throughput is throttled and this worker must be running
 * for discovery jobs to make progress.
 */

import { createClient } from "@supabase/supabase-js";

import { runDiscoveryWorkerTick, tickIsIdle } from "../src/discovery/worker";

// Load .env.local if present, so `npm run worker` picks up the Supabase keys
// without any extra flags. Best-effort: no-ops when the file or the Node API
// (loadEnvFile, Node 20.12+) is absent, since Vercel/CI set env another way.
try {
  (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(".env.local");
} catch {
  // No .env.local — rely on the ambient environment.
}

const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE ?? 3);
const IDLE_DELAY_MS = Number(process.env.WORKER_IDLE_DELAY_MS ?? 15_000);
const BUSY_DELAY_MS = Number(process.env.WORKER_BUSY_DELAY_MS ?? 1_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the worker.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("Finishing the current tick, then stopping…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Discovery worker started (batch ${BATCH_SIZE}). Waiting for work…`);

  while (!stopping) {
    try {
      const result = await runDiscoveryWorkerTick(supabase, { limit: BATCH_SIZE });
      if (!tickIsIdle(result)) {
        console.log(
          `Tick: ${result.discovery} discovery, ${result.publishers} publisher, ` +
            `${result.enrich} enrich.`,
        );
      }
      await sleep(tickIsIdle(result) ? IDLE_DELAY_MS : BUSY_DELAY_MS);
    } catch (error) {
      console.error("Tick failed:", error instanceof Error ? error.message : error);
      await sleep(IDLE_DELAY_MS);
    }
  }

  console.log("Worker stopped.");
  process.exit(0);
}

void main();
