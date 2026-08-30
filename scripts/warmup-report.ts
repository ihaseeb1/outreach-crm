/**
 * Phase 2 verification report — read-only, writes nothing, deletes nothing.
 *
 *   Environment: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   npx tsx scripts/warmup-report.ts
 *
 * Prints, per workspace:
 *   - a per-account count of is_warmup = true vs false
 *   - a sample of the flagged rows
 *   - the safety assertion: ZERO flagged rows have any external counterparty
 *     (re-derived from the live pool, independently of the flag itself)
 *   - how many rows LOOK like warmup by the pool rule but are not yet flagged
 *     (i.e. whether the backfill still needs to run)
 *
 * Exits non-zero if the safety assertion fails, so it is safe to gate on.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { messageIsWarmup, recipientsOf } from "../src/warmup/deletion";
import { loadWorkspacePools, type WorkspacePool } from "../src/warmup/pool";

const PAGE = 1000;
const SAMPLE = 15;

interface Row {
  id: string;
  direction: "outbound" | "inbound";
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  sent_at: string | null;
  meta: Record<string, unknown> | null;
  is_warmup: boolean | null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.",
    );
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const pools = await loadWorkspacePools(supabase);
  let anyViolation = false;

  for (const [workspaceId, pool] of pools) {
    const violated = await reportWorkspace(supabase, workspaceId, pool);
    anyViolation = anyViolation || violated;
  }

  console.log("\n" + "=".repeat(64));
  if (anyViolation) {
    console.log(
      "FAIL: some flagged rows have an external counterparty. Do NOT enable\n" +
        "deletion. Investigate the rows listed above first.",
    );
    process.exit(1);
  }
  console.log(
    "PASS: every is_warmup=true row is warmup by the pool rule — both sender\n" +
      "and every recipient is one of your own connected mailboxes. No outreach\n" +
      "email is flagged. Safe to review and, when you are ready, enable deletion.",
  );
}

async function reportWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
): Promise<boolean> {
  // Per-account tallies keyed by the account's own address.
  const warmupByAccount = new Map<string, number>();
  const outreachByAccount = new Map<string, number>();
  for (const email of pool.emails) {
    warmupByAccount.set(email, 0);
    outreachByAccount.set(email, 0);
  }

  let flagged = 0;
  let unflagged = 0;
  let violations = 0; // flagged, but external by the pool rule — must be 0
  let missedWarmup = 0; // warmup by pool, but not flagged — backfill still due
  const sample: Row[] = [];
  const violationSample: Row[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, direction, from_email, to_email, subject, sent_at, meta, is_warmup")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`messages read failed: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const isFlagged = row.is_warmup === true;
      const isWarmupByRule = messageIsWarmup(row, pool.emails);
      const account = (row.from_email ?? "").trim().toLowerCase();

      if (isFlagged) {
        flagged += 1;
        if (pool.emails.has(account)) {
          warmupByAccount.set(account, (warmupByAccount.get(account) ?? 0) + 1);
        }
        if (sample.length < SAMPLE) sample.push(row);
        if (!isWarmupByRule) {
          violations += 1;
          if (violationSample.length < SAMPLE) violationSample.push(row);
        }
      } else {
        unflagged += 1;
        if (row.direction === "outbound" && pool.emails.has(account)) {
          outreachByAccount.set(
            account,
            (outreachByAccount.get(account) ?? 0) + 1,
          );
        }
        if (isWarmupByRule) missedWarmup += 1;
      }
    }

    if (rows.length < PAGE) break;
  }

  console.log("\n" + "=".repeat(64));
  console.log(`Workspace ${workspaceId} — ${pool.emails.size} connected account(s)`);
  console.log(`  flagged warmup: ${flagged}   not warmup: ${unflagged}`);
  console.log("\n  Per account (outbound):   warmup / outreach");
  for (const { email } of pool.mailboxes) {
    const w = warmupByAccount.get(email) ?? 0;
    const o = outreachByAccount.get(email) ?? 0;
    console.log(`    ${email.padEnd(34)} ${String(w).padStart(6)} / ${o}`);
  }

  if (sample.length > 0) {
    console.log("\n  Sample of flagged rows:");
    for (const row of sample) {
      console.log(
        `    ${(row.sent_at ?? "—").slice(0, 19)}  ${short(row.from_email)}` +
          ` -> ${recipientsOf(row).map(short).join(", ") || "—"}` +
          `  ${JSON.stringify(row.subject ?? "").slice(0, 40)}`,
      );
    }
  }

  if (missedWarmup > 0) {
    console.log(
      `\n  NOTE: ${missedWarmup} row(s) are warmup by the pool rule but not yet` +
        ` flagged.\n  Run scripts/backfill-warmup-flag.ts --apply to flag them.`,
    );
  }

  if (violations > 0) {
    console.log(
      `\n  *** ${violations} FLAGGED ROW(S) HAVE AN EXTERNAL COUNTERPARTY ***`,
    );
    for (const row of violationSample) {
      console.log(
        `    id ${row.id}  ${short(row.from_email)} -> ` +
          `${recipientsOf(row).map(short).join(", ")}`,
      );
    }
  } else {
    console.log(
      "\n  Safety assertion: 0 flagged rows have an external counterparty. OK.",
    );
  }

  return violations > 0;
}

function short(email: string | null | undefined): string {
  return (email ?? "—").trim().toLowerCase();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
