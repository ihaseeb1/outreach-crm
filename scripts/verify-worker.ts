/**
 * Deep email-verification worker (SMTP "power" mode).
 *
 * The hosted app and the CI cron cannot open outbound port 25, so they can only
 * do the quick checks (syntax, MX, disposable, role, traps). This worker does
 * the part that actually confirms a mailbox exists: a real SMTP conversation
 * with each recipient's MX server. Run it on any always-on box where outbound
 * port 25 is open — a small VPS is the reliable choice, since many home and
 * office ISPs block port 25.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/verify-worker.ts
 *
 * It picks up contacts the quick check flagged `meta.needs_power`, verifies each
 * against its MX, and — per your setting — removes and suppresses any that come
 * back undeliverable (no such mailbox, disabled, full). Stop with Ctrl-C; it
 * finishes the current batch first.
 */

import { createClient } from "@supabase/supabase-js";

import { runPowerVerificationBatch } from "../src/validation/run";

const BATCH_SIZE = Number(process.env.VERIFY_BATCH_SIZE ?? 20);
const IDLE_DELAY_MS = Number(process.env.VERIFY_IDLE_DELAY_MS ?? 30_000);
const BUSY_DELAY_MS = Number(process.env.VERIFY_BUSY_DELAY_MS ?? 2_000);

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

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("Finishing the current batch, then stopping…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Power verification worker started (batch ${BATCH_SIZE}).`);
  console.log(
    "This needs outbound port 25. If every check comes back 'could not connect', your host is blocking it — move to a VPS that allows port 25.",
  );

  while (!stopping) {
    try {
      const result = await runPowerVerificationBatch(supabase, { limit: BATCH_SIZE });

      if (result.processed > 0) {
        console.log(
          `Checked ${result.processed}: ${result.valid} kept, ${result.removed} removed, ` +
            `${result.suppressed} suppressed.`,
        );
      }

      await sleep(result.processed > 0 ? BUSY_DELAY_MS : IDLE_DELAY_MS);
    } catch (error) {
      console.error("Batch failed:", error instanceof Error ? error.message : error);
      await sleep(IDLE_DELAY_MS);
    }
  }

  console.log("Worker stopped.");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
