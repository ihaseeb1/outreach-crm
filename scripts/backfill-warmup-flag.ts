/**
 * Backfill `messages.is_warmup` using the pool-membership rule.
 *
 *   Environment: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   Dry run (default, writes nothing):  npx tsx scripts/backfill-warmup-flag.ts
 *   Apply:                              npx tsx scripts/backfill-warmup-flag.ts --apply
 *
 * A message is warmup ONLY when both the sender and every recipient is one of
 * your own connected mailboxes. Everything else stays false — the fail-safe
 * default — so a real publisher/webmaster email can never be flagged. The pass
 * sets `is_warmup` to exactly the pool-membership truth (true where it holds,
 * false where it does not), so it is idempotent and self-correcting: running it
 * twice changes nothing the second time.
 *
 * This only writes a boolean flag. It deletes nothing. Deletion is a separate,
 * gated job (src/warmup/purge.ts) that stays off until you turn it on.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { messageIsWarmup } from "../src/warmup/deletion";
import { loadWorkspacePools, type WorkspacePool } from "../src/warmup/pool";

const PAGE = 1000;
const UPDATE_CHUNK = 200;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.",
    );
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    apply
      ? "APPLY mode — writing is_warmup.\n"
      : "DRY RUN — nothing is written. Re-run with --apply to commit.\n",
  );

  const pools = await loadWorkspacePools(supabase);
  if (pools.size === 0) {
    console.log("No mailboxes found — nothing to do.");
    return;
  }

  let totalToTrue = 0;
  let totalToFalse = 0;
  let totalScanned = 0;

  for (const [workspaceId, pool] of pools) {
    if (pool.emails.size === 0) continue;
    const { scanned, toTrue, toFalse } = await backfillWorkspace(
      supabase,
      workspaceId,
      pool,
      apply,
    );
    totalScanned += scanned;
    totalToTrue += toTrue;
    totalToFalse += toFalse;
    console.log(
      `  workspace ${workspaceId}: ${pool.emails.size} accounts, ` +
        `scanned ${scanned}, +warmup ${toTrue}, -warmup ${toFalse}`,
    );
  }

  console.log(
    `\nDone. Scanned ${totalScanned} messages across ${pools.size} workspace(s). ` +
      `${apply ? "Flagged" : "Would flag"} ${totalToTrue} as warmup` +
      (totalToFalse > 0 ? `, ${totalToFalse} corrected back to false` : "") +
      ".",
  );
  if (!apply && totalToTrue + totalToFalse > 0) {
    console.log("Re-run with --apply to write these changes.");
  }
}

async function backfillWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
  apply: boolean,
): Promise<{ scanned: number; toTrue: number; toFalse: number }> {
  const toTrue: string[] = [];
  const toFalse: string[] = [];
  let scanned = 0;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, from_email, to_email, meta, is_warmup")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`messages read failed: ${error.message}`);
    const rows = (data ?? []) as {
      id: string;
      from_email: string | null;
      to_email: string | null;
      meta: Record<string, unknown> | null;
      is_warmup: boolean | null;
    }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const desired = messageIsWarmup(row, pool.emails);
      const current = row.is_warmup === true;
      if (desired && !current) toTrue.push(row.id);
      else if (!desired && current) toFalse.push(row.id);
    }

    if (rows.length < PAGE) break;
  }

  if (apply) {
    await setFlag(supabase, toTrue, true);
    await setFlag(supabase, toFalse, false);
  }

  return { scanned, toTrue: toTrue.length, toFalse: toFalse.length };
}

async function setFlag(
  supabase: SupabaseClient,
  ids: string[],
  value: boolean,
): Promise<void> {
  for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
    const chunk = ids.slice(i, i + UPDATE_CHUNK);
    const { error } = await supabase
      .from("messages")
      .update({ is_warmup: value })
      .in("id", chunk);
    if (error) throw new Error(`update failed: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
