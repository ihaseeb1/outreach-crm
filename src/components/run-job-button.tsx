"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Runs one batch of a background job for the current workspace. The same
 * batches run automatically on the cron tick; this is for impatience and testing.
 */
export type RunnableJob =
  | "scrape"
  | "validate"
  | "inbound"
  | "campaigns"
  | "warmup"
  | "health";

export function RunJobButton({
  job,
  label,
  limit,
  extra,
  variant = "secondary",
}: {
  job: RunnableJob;
  label: string;
  limit?: number;
  /** Extra fields for the job payload, e.g. an inbound rescan depth. */
  extra?: Record<string, unknown>;
  variant?: "secondary" | "ghost";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function once(): Promise<Record<string, any>> {
    const response = await fetch("/api/jobs/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job, limit, ...extra }),
    });
    // Not response.json(): a function that overruns its limit is answered by
    // the platform, not by us, and that answer is an HTML error page. Parsing
    // it blind produced "Unexpected token 'A'… is not valid JSON", which told
    // nobody anything. Read the body, then decide.
    const body = await response.text();
    const payload = parseJson(body);

    if (!payload) {
      throw new Error(
        response.status === 504 || /timed?\s?out|FUNCTION_INVOCATION_TIMEOUT/i.test(body)
          ? "That took too long and was cut off. Anything already checked has been saved — run it again to continue."
          : `The server returned an error (HTTP ${response.status}).`,
      );
    }

    if (!response.ok) throw new Error(payload.error ?? "Job failed.");
    return payload;
  }

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const payload = job === "inbound" ? await pollEveryMailbox(once, setMessage) : await once();
      setMessage(describe(job, payload));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        className={variant === "ghost" ? "btn-ghost" : "btn-secondary"}
        onClick={run}
        disabled={busy}
        type="button"
      >
        {busy ? "Running…" : label}
      </button>
      {message && <span className="hint">{message}</span>}
    </div>
  );
}

/**
 * Keeps asking until every mailbox has actually been checked.
 *
 * One request can only do as much as a 60-second function allows, so a
 * workspace with more mailboxes than fit in one round used to be told
 * "3 not reached — run again for the rest" and left to press the button
 * repeatedly. The server orders its queue by least-recently-polled and stamps
 * each mailbox as it goes, so simply asking again picks up exactly where the
 * last round stopped: the button does the pressing.
 *
 * Bounded two ways — a round cap, and a check that each round made progress —
 * because a mailbox that fails instantly would otherwise be retried forever.
 */
const MAX_POLL_ROUNDS = 8;

async function pollEveryMailbox(
  once: () => Promise<Record<string, any>>,
  report: (message: string) => void,
): Promise<Record<string, any>> {
  let merged: Record<string, any> | null = null;

  for (let round = 0; round < MAX_POLL_ROUNDS; round += 1) {
    const payload = await once();
    merged = merged ? mergeInbound(merged, payload) : payload;

    const deferred: number = payload.deferred ?? 0;
    if (deferred <= 0) break;
    if ((payload.polled ?? 0) === 0) break; // No progress; asking again cannot help.

    report(
      `Checked ${merged.polled} so far, ${deferred} to go…`,
    );
  }

  return merged ?? {};
}

/** Adds a round's numbers onto the running total. */
function mergeInbound(
  total: Record<string, any>,
  next: Record<string, any>,
): Record<string, any> {
  const add = (key: string) => (total[key] ?? 0) + (next[key] ?? 0);

  return {
    ...total,
    polled: add("polled"),
    examined: add("examined"),
    fetched: add("fetched"),
    replies: add("replies"),
    bounces: add("bounces"),
    warmup: add("warmup"),
    duplicates: add("duplicates"),
    failed: add("failed"),
    // Not summed: these describe the state of the queue right now, and the
    // latest round is the only one still true.
    deferred: next.deferred ?? 0,
    queued: next.queued ?? total.queued ?? 0,
    unpollable: next.unpollable ?? total.unpollable ?? [],
    perMailbox: [...(total.perMailbox ?? []), ...(next.perMailbox ?? [])],
    errors: [...(total.errors ?? []), ...(next.errors ?? [])],
  };
}

function parseJson(body: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function describe(job: RunnableJob, payload: Record<string, any>): string {
  switch (job) {
    case "scrape":
      return `Scraped ${payload.processed}, found ${payload.contactsCreated} new contacts.`;
    case "validate":
      return `Validated ${payload.processed} (${payload.valid} sendable).`;
    case "inbound":
      return describeInbound(payload);
    case "campaigns":
      return `Sent ${payload.sent}, skipped ${payload.skipped}, completed ${payload.completed}.`;
    case "warmup":
      return `Warmup: ${payload.sent} sent, ${payload.engaged} opened, ${payload.rescued} rescued from spam, ${payload.replied} replied.`;
    case "health":
      return `Checked ${payload.checked}: ${payload.paused} paused, ${payload.warnings} warning(s), ${payload.recovered} recovered.`;
  }
}

/**
 * Says what was actually checked, not just what came back.
 *
 * "Polled 1 mailbox(es): 0 replies" read as "there are no replies" when it
 * meant "seven mailboxes were never looked at". Anything left over, and
 * anything that failed, is named.
 */
function describeInbound(payload: Record<string, any>): string {
  const deferred: number = payload.deferred ?? 0;
  const polled: number = payload.polled ?? 0;
  // `queued` is how many mailboxes the workspace actually has connected, read
  // before any budget was applied. Deriving the total from polled + deferred
  // instead is what produced "Checked 5 of 5" on a seven-mailbox workspace: the
  // two that were never queued could not appear in either number.
  const unpollable: { email: string; reason: string }[] = payload.unpollable ?? [];
  const total: number =
    Math.max(payload.queued ?? 0, polled + deferred) + unpollable.length;
  const errors: string[] = payload.errors ?? [];
  const failures = (payload.perMailbox ?? []).filter(
    (row: Record<string, any>) => row.error,
  );

  const parts = [
    `Checked ${polled} of ${total} mailbox${total === 1 ? "" : "es"}`,
    `${payload.replies} new repl${payload.replies === 1 ? "y" : "ies"}`,
    `${payload.bounces} bounce${payload.bounces === 1 ? "" : "s"}`,
  ];

  if (payload.rescan) parts.push(`${payload.duplicates ?? 0} already saved`);

  let text = `${parts[0]}: ${parts.slice(1).join(", ")}.`;

  if (failures.length > 0) {
    text += ` ${polled - failures.length} of those answered; ${failures.length} did not.`;
  }
  if (deferred > 0) text += ` ${deferred} not reached — run again for the rest.`;
  if (payload.failed) text += ` ${payload.failed} could not be saved.`;
  for (const row of unpollable) text += ` ${row.email}: ${row.reason}.`;
  if (errors.length > 0) text += ` ${errors.join(" · ")}`;

  return text;
}
