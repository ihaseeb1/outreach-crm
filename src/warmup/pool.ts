import type { SupabaseClient } from "@supabase/supabase-js";

import type { PoolSet } from "@/warmup/deletion";

/**
 * "My accounts" — the warmup pool — loaded from the connected-mailbox records,
 * grouped by workspace. This is the ground truth every warmup-deletion path
 * tests against: a mail is warmup only if both parties are in here.
 *
 * Deliberately reads EVERY mailbox, active or paused, connected or not: a
 * paused mailbox is still one of your own addresses, and treating its warmup
 * mail as external (and therefore protected-from-deletion / or worse, deletable
 * outreach) would be wrong either way. Membership of the pool is about whose
 * address it is, nothing else.
 */
export interface WorkspacePool {
  workspaceId: string;
  emails: PoolSet;
  /** mailbox id -> lowercased email */
  byId: Map<string, string>;
  mailboxes: { id: string; email: string }[];
}

export async function loadWorkspacePools(
  supabase: SupabaseClient,
  workspaceId?: string,
): Promise<Map<string, WorkspacePool>> {
  let query = supabase.from("mailboxes").select("id, email, workspace_id");
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load mailboxes: ${error.message}`);

  const rows = (data ?? []) as {
    id: string;
    email: string;
    workspace_id: string;
  }[];

  const pools = new Map<string, WorkspacePool>();
  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase();
    const pool =
      pools.get(row.workspace_id) ??
      ({
        workspaceId: row.workspace_id,
        emails: new Set<string>(),
        byId: new Map<string, string>(),
        mailboxes: [],
      } satisfies WorkspacePool);

    if (email) {
      pool.emails.add(email);
      pool.byId.set(row.id, email);
      pool.mailboxes.push({ id: row.id, email });
    }
    pools.set(row.workspace_id, pool);
  }

  return pools;
}
