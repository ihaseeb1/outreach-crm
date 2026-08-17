import type { SupabaseClient } from "@supabase/supabase-js";

import { pollMailbox, type PollResult } from "@/mail/inbound";
import type { Mailbox } from "@/types/db";

/**
 * Cron batch: poll the mailboxes that have gone longest without a check.
 *
 * Bounded so one tick never blows the function timeout — with many mailboxes
 * connected, each one still gets polled every few ticks.
 */
export async function runInboundPoll(
  supabase: SupabaseClient,
  options: {
    limit?: number;
    workspaceId?: string;
    mailboxId?: string;
    budgetMs?: number;
  } = {},
): Promise<{ polled: number; results: PollResult[]; deferred: number }> {
  // One mailbox is ~25s of IMAP, and a busy one is more. The default of three
  // reliably overran the 60s function limit, which threw away the results of
  // any mailbox already polled in that run.
  const limit = options.limit ?? 1;
  const budgetMs = options.budgetMs ?? 40_000;
  const startedAt = Date.now();

  let query = supabase
    .from("mailboxes")
    .select("*")
    .eq("is_active", true)
    .not("encrypted_credentials", "is", null)
    // nullsFirst so a freshly connected mailbox is polled straight away.
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
  if (options.mailboxId) query = query.eq("id", options.mailboxId);

  const { data } = await query;
  const mailboxes = (data ?? []) as Mailbox[];

  const results: PollResult[] = [];
  let deferred = 0;

  for (const mailbox of mailboxes) {
    // Never start another mailbox without room to finish it. Ordering is by
    // last_polled_at, so whatever is deferred is first in line next run.
    if (results.length > 0 && Date.now() - startedAt > budgetMs / 2) {
      deferred = mailboxes.length - results.length;
      break;
    }
    results.push(await pollMailbox(supabase, mailbox));
  }

  return { polled: results.length, results, deferred };
}
