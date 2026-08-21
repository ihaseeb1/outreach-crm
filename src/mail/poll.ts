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
    /** Mailboxes to consider. Omit for no cap — every one that qualifies. */
    limit?: number;
    concurrency?: number;
    workspaceId?: string;
    mailboxId?: string;
    budgetMs?: number;
    /** Recovery: re-read this many UIDs below each mailbox's checkpoint. */
    rescanUids?: number;
    fetchLimit?: number;
    headerLimit?: number;
    mailboxTimeoutMs?: number;
    /**
     * Poll mailboxes that are switched off for sending too.
     *
     * Sending and receiving are different questions. A paused mailbox must not
     * send, but a reply that lands in it is still a reply, and skipping it
     * silently is what made "Poll mailboxes now" report *Checked 5 of 5* on a
     * workspace with seven connected accounts — the two that were switched off
     * were never in the queue to be counted, so nothing on screen said they had
     * been left out.
     */
    includeInactive?: boolean;
  } = {},
): Promise<{
  polled: number;
  results: PollResult[];
  deferred: number;
  /** How many mailboxes were in the queue before the budget was applied. */
  queued: number;
  /** Connected mailboxes that could not be queued at all, and why. */
  unpollable: { email: string; reason: string }[];
}> {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const budgetMs = options.budgetMs ?? 40_000;
  const startedAt = Date.now();

  let query = supabase
    .from("mailboxes")
    .select("*")
    .not("encrypted_credentials", "is", null)
    // nullsFirst so a freshly connected mailbox is polled straight away.
    .order("last_polled_at", { ascending: true, nullsFirst: true });

  if (!options.includeInactive) query = query.eq("is_active", true);
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
  if (options.mailboxId) query = query.eq("id", options.mailboxId);

  const { data } = await query;
  const queue = (data ?? []) as Mailbox[];
  const queued = queue.length;

  // Anything that could not even join the queue, named rather than silently
  // absent. A mailbox with no stored credentials is invisible to the query
  // above, so without this a workspace of seven can be told "checked 5 of 5"
  // and have no way at all to find out what happened to the other two.
  const unpollable = options.mailboxId
    ? []
    : await unpollableMailboxes(supabase, options.workspaceId);

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
          headerLimit: options.headerLimit,
          timeoutMs: options.mailboxTimeoutMs ?? MAILBOX_TIMEOUT_MS,
        }),
      );
      estimateMs = Math.max(estimateMs, Date.now() - mailboxStartedAt);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Whatever is left is first in line next run — the query is ordered by
  // last_polled_at, and polling stamps it.
  return {
    polled: results.length,
    results,
    deferred: queue.length,
    queued,
    unpollable,
  };
}

/**
 * Connected mailboxes that cannot be polled at all, with the reason.
 *
 * Only one reason for now — no stored credentials, which is what a mailbox
 * looks like after the row was created but the connect step never finished.
 */
async function unpollableMailboxes(
  supabase: SupabaseClient,
  workspaceId?: string,
): Promise<{ email: string; reason: string }[]> {
  let query = supabase
    .from("mailboxes")
    .select("email")
    .is("encrypted_credentials", null);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data } = await query;
  return ((data ?? []) as { email: string }[]).map((row) => ({
    email: row.email,
    reason: "no stored credentials — reconnect it",
  }));
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
  options: {
    rescanUids?: number;
    fetchLimit?: number;
    headerLimit?: number;
    timeoutMs: number;
  },
): Promise<PollResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Abandoning a poll is not enough on its own: the IMAP socket carries on
  // reading, still counting against the provider's per-account connection
  // limit, and the next mailbox to ask for a connection is the one that gets
  // "Connection not available". Aborting hangs up.
  const controller = new AbortController();

  const timeout = new Promise<PollResult | null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, options.timeoutMs);
  });

  try {
    const result = await Promise.race([
      pollMailbox(supabase, mailbox, {
        rescanUids: options.rescanUids,
        fetchLimit: options.fetchLimit,
        headerLimit: options.headerLimit,
        signal: controller.signal,
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
      examined: 0,
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
    controller.abort();
  }
}

/** Flattens a batch into the numbers every caller reports. */
export function summarisePoll(results: PollResult[]) {
  const sum = (pick: (result: PollResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);

  return {
    examined: sum((r) => r.examined),
    fetched: sum((r) => r.fetched),
    replies: sum((r) => r.replies),
    bounces: sum((r) => r.bounces),
    warmup: sum((r) => r.warmup),
    ignored: sum((r) => r.ignored),
    duplicates: sum((r) => r.duplicates),
    failed: sum((r) => r.failed),
    mailboxes: results.map((r) => r.mailboxEmail),
    // One line per mailbox, so a run that half worked says which half. The
    // aggregate alone read as "0 replies" whether that meant nothing arrived or
    // two accounts never connected.
    perMailbox: results.map((result) => ({
      email: result.mailboxEmail,
      examined: result.examined,
      replies: result.replies,
      bounces: result.bounces,
      error: result.error ?? null,
    })),
    errors: results
      .filter((r) => r.error)
      .map((r) => `${r.mailboxEmail}: ${r.error}`),
  };
}
