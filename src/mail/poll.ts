import type { SupabaseClient } from "@supabase/supabase-js";

import { pollMailbox, type PollResult } from "@/mail/inbound";
import type { Mailbox } from "@/types/db";

/**
 * Batch poller: checks the mailboxes that have gone longest without a look.
 *
 * Mailboxes are polled **concurrently**. IMAP is nearly all waiting — connect,
 * fetch, parse, disconnect — so running one at a time meant a single mailbox
 * ate the whole function budget and the run stopped after it. Seven mailboxes
 * checked one per half-hourly tick is a reply sitting unseen for three and a
 * half hours; checked four at a time it is under an hour, with no more risk of
 * a timeout than before.
 */

/**
 * Floor for "how long does a mailbox take". Starting a mailbox with less than
 * this left is how a run gets cut off mid-write.
 */
const MIN_ESTIMATE_MS = 12_000;

/**
 * Hard ceiling on a single mailbox.
 *
 * The batch budget is only consulted *before* a mailbox starts, so without this
 * one hung IMAP connection runs the whole function into Vercel's 60s wall. A
 * 504 has no body, so the caller gets Vercel's HTML error page instead of JSON
 * and every mailbox already polled in that run goes unreported.
 */
const MAILBOX_TIMEOUT_MS = 25_000;

/**
 * Is there room to start another mailbox?
 *
 * The first one always goes ahead — a budget too small for any mailbox at all
 * should still poll one, otherwise a slow account stops the inbox updating
 * forever.
 */
export function canStartAnother(input: {
  startedCount: number;
  elapsedMs: number;
  budgetMs: number;
  estimateMs: number;
}): boolean {
  if (input.startedCount === 0) return true;
  return input.elapsedMs + input.estimateMs <= input.budgetMs;
}

export async function runInboundPoll(
  supabase: SupabaseClient,
  options: {
    limit?: number;
    concurrency?: number;
    workspaceId?: string;
    mailboxId?: string;
    budgetMs?: number;
    /** Recovery: re-read this many UIDs below each mailbox's checkpoint. */
    rescanUids?: number;
    fetchLimit?: number;
    mailboxTimeoutMs?: number;
  } = {},
): Promise<{
  polled: number;
  results: PollResult[];
  deferred: number;
}> {
  const limit = options.limit ?? 1;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, limit));
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
  const queue = (data ?? []) as Mailbox[];

  const results: PollResult[] = [];
  let started = 0;
  // Grows to whatever the slowest mailbox so far actually took, so a workspace
  // of quick mailboxes gets through all of them and a slow one still stops in
  // time.
  let estimateMs = MIN_ESTIMATE_MS;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      if (
        !canStartAnother({
          startedCount: started,
          elapsedMs: Date.now() - startedAt,
          budgetMs,
          estimateMs,
        })
      ) {
        return;
      }

      const mailbox = queue.shift();
      if (!mailbox) return;

      started += 1;
      const mailboxStartedAt = Date.now();
      results.push(
        await pollWithTimeout(supabase, mailbox, {
          rescanUids: options.rescanUids,
          fetchLimit: options.fetchLimit,
          timeoutMs: options.mailboxTimeoutMs ?? MAILBOX_TIMEOUT_MS,
        }),
      );
      estimateMs = Math.max(estimateMs, Date.now() - mailboxStartedAt);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Whatever is left is first in line next run — the query is ordered by
  // last_polled_at, and polling stamps it.
  return { polled: results.length, results, deferred: queue.length };
}

/**
 * One mailbox, with a stopwatch on it.
 *
 * A mailbox that overruns is reported as an error and left behind rather than
 * being allowed to sink the run. `last_polled_at` is stamped even so: the queue
 * is ordered by that column, and a mailbox that fails without being stamped
 * would be picked first every single time and time out forever, starving every
 * other account.
 */
async function pollWithTimeout(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  options: { rescanUids?: number; fetchLimit?: number; timeoutMs: number },
): Promise<PollResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<PollResult | null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.timeoutMs);
  });

  try {
    const result = await Promise.race([
      pollMailbox(supabase, mailbox, {
        rescanUids: options.rescanUids,
        fetchLimit: options.fetchLimit,
      }),
      timeout,
    ]);

    if (result) return result;

    const error = `Timed out after ${Math.round(options.timeoutMs / 1000)}s.`;
    await supabase
      .from("mailboxes")
      .update({
        last_polled_at: new Date().toISOString(),
        last_error: `Inbound: ${error}`,
      })
      .eq("id", mailbox.id);

    return {
      mailboxId: mailbox.id,
      mailboxEmail: mailbox.email,
      fetched: 0,
      replies: 0,
      bounces: 0,
      autoReplies: 0,
      warmup: 0,
      ignored: 0,
      duplicates: 0,
      failed: 0,
      error,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Flattens a batch into the numbers every caller reports. */
export function summarisePoll(results: PollResult[]) {
  const sum = (pick: (result: PollResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);

  return {
    replies: sum((r) => r.replies),
    bounces: sum((r) => r.bounces),
    warmup: sum((r) => r.warmup),
    ignored: sum((r) => r.ignored),
    duplicates: sum((r) => r.duplicates),
    failed: sum((r) => r.failed),
    mailboxes: results.map((r) => r.mailboxEmail),
    errors: results
      .filter((r) => r.error)
      .map((r) => `${r.mailboxEmail}: ${r.error}`),
  };
}
