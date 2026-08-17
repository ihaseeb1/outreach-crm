"use client";

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

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
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

/* eslint-disable @typescript-eslint/no-explicit-any */
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
  const total = (payload.polled ?? 0) + deferred;
  const errors: string[] = payload.errors ?? [];

  const parts = [
    `Checked ${payload.polled} of ${total} mailbox${total === 1 ? "" : "es"}`,
    `${payload.replies} new repl${payload.replies === 1 ? "y" : "ies"}`,
    `${payload.bounces} bounce${payload.bounces === 1 ? "" : "s"}`,
  ];

  if (payload.rescan) parts.push(`${payload.duplicates ?? 0} already saved`);

  let text = `${parts[0]}: ${parts.slice(1).join(", ")}.`;
  if (deferred > 0) text += ` ${deferred} not reached — run again for the rest.`;
  if (payload.failed) text += ` ${payload.failed} could not be saved.`;
  if (errors.length > 0) text += ` ${errors.join(" · ")}`;

  return text;
}
