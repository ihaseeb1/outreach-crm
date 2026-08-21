/**
 * Reading and writing the open/click record that lives on `messages.meta`.
 *
 * Deliberately pure and free of `node:crypto`, so a page or a client component
 * can summarise a message without dragging the signer into its bundle — the
 * same split `lib/html.ts` exists for. The signing and the link rewriting are
 * in `mail/tracking.ts`.
 *
 * **Why `meta` and not columns.** Every migration in this project is applied by
 * hand in the Supabase SQL editor, so a feature that needs one is dark between
 * deploying and remembering to run it — and a half-applied schema breaks reads
 * on pages that have nothing to do with tracking. `messages.meta` is jsonb that
 * already exists on every row, is already selected by the pages that would show
 * this, and needs nothing run anywhere. The cost is that two opens arriving in
 * the same instant can lose a count to a read-modify-write race; a duplicated
 * open of the same email is not a number anyone acts on.
 */

export const TRACKING_MODES = ["off", "opens", "opens_and_clicks"] as const;

export type TrackingMode = (typeof TRACKING_MODES)[number];

export const TRACKING_LABELS: Record<TrackingMode, string> = {
  off: "Off — no pixel, no rewritten links",
  opens: "Opens only — a tracking pixel, links left alone",
  opens_and_clicks: "Opens and clicks — pixel, and links routed through the CRM",
};

/** The default. Both halves of what was asked for; Settings can turn it down. */
export const DEFAULT_TRACKING_MODE: TrackingMode = "opens_and_clicks";

export function isTrackingMode(value: unknown): value is TrackingMode {
  return (
    typeof value === "string" && (TRACKING_MODES as readonly string[]).includes(value)
  );
}

/** Reads the mode out of `workspaces.settings`, falling back to the default. */
export function resolveTrackingMode(
  settings: Record<string, unknown> | null | undefined,
): TrackingMode {
  const value = settings?.tracking;
  return isTrackingMode(value) ? value : DEFAULT_TRACKING_MODE;
}

export interface TrackingEvent {
  count: number;
  first_at: string | null;
  last_at: string | null;
}

/** What is stored under `meta.tracking`. */
export interface TrackingRecord {
  mode?: TrackingMode;
  open?: TrackingEvent;
  click?: TrackingEvent;
  /** How many clicks each link took, so "which link" is answerable. */
  urls?: Record<string, number>;
}

export interface TrackingSummary {
  opens: number;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  clicks: number;
  firstClickAt: string | null;
  lastClickAt: string | null;
  links: { url: string; count: number }[];
  /** False when the message was sent with tracking switched off. */
  tracked: boolean;
}

const EMPTY: TrackingEvent = { count: 0, first_at: null, last_at: null };

function readEvent(value: unknown): TrackingEvent {
  if (!value || typeof value !== "object") return EMPTY;
  const event = value as Partial<TrackingEvent>;
  return {
    count: typeof event.count === "number" && event.count > 0 ? event.count : 0,
    first_at: typeof event.first_at === "string" ? event.first_at : null,
    last_at: typeof event.last_at === "string" ? event.last_at : null,
  };
}

/**
 * The tracking on one message.
 *
 * Returns null when the row carries no tracking at all — an inbound message, or
 * anything sent before this existed. That is different from "sent with tracking
 * and never opened", which returns a summary of zeroes, and the two must not
 * render the same way: one is "we do not know", the other is "they did not".
 */
export function readTracking(
  meta: Record<string, unknown> | null | undefined,
): TrackingSummary | null {
  const record = meta?.tracking as TrackingRecord | undefined;
  if (!record || typeof record !== "object") return null;

  const open = readEvent(record.open);
  const click = readEvent(record.click);
  const urls = (record.urls ?? {}) as Record<string, number>;

  return {
    opens: open.count,
    firstOpenAt: open.first_at,
    lastOpenAt: open.last_at,
    clicks: click.count,
    firstClickAt: click.first_at,
    lastClickAt: click.last_at,
    links: Object.entries(urls)
      .map(([url, count]) => ({ url, count: Number(count) || 0 }))
      .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url)),
    tracked: record.mode !== "off",
  };
}

/**
 * Folds one open or click into a message's meta, returning the new meta.
 *
 * The first timestamp is never overwritten — "when did they first open it" is
 * the question the user actually asked, and a later open must not move it.
 */
export function recordEvent(
  meta: Record<string, unknown> | null | undefined,
  kind: "open" | "click",
  at: string,
  url?: string | null,
): Record<string, unknown> {
  const base = { ...(meta ?? {}) };
  const record: TrackingRecord = {
    ...((base.tracking as TrackingRecord | undefined) ?? {}),
  };

  const previous = readEvent(record[kind]);
  record[kind] = {
    count: previous.count + 1,
    first_at: previous.first_at ?? at,
    last_at: at,
  };

  // A click means it was opened, whatever the pixel did. Images blocked and a
  // link clicked is the ordinary case for anyone reading mail with images off,
  // and reporting "clicked but never opened" would read as a bug.
  if (kind === "click") {
    const opens = readEvent(record.open);
    record.open = {
      count: Math.max(opens.count, 1),
      first_at: opens.first_at ?? at,
      last_at: opens.last_at ?? at,
    };

    if (url) {
      const urls = { ...(record.urls ?? {}) };
      urls[url] = (Number(urls[url]) || 0) + 1;
      record.urls = urls;
    }
  }

  base.tracking = record;
  return base;
}

export interface EngagementSummary {
  /** Outbound emails looked at (whatever their tracking state). */
  sent: number;
  /** Of those, how many were sent with tracking on — the honest denominator. */
  tracked: number;
  /** How many were sent with click tracking specifically (links rewritten). */
  clickTracked: number;
  /** Distinct emails opened at least once. */
  openedEmails: number;
  /** Distinct emails clicked at least once. */
  clickedEmails: number;
  /** Total opens and clicks across all of them. */
  opens: number;
  clicks: number;
  /** openedEmails / tracked and clickedEmails / tracked. 0 when nothing tracked. */
  openRate: number;
  clickRate: number;
}

/**
 * Rolls a whole period's worth of sent emails up into open/click totals for the
 * Reports page.
 *
 * The rate denominator is **tracked**, not **sent**: an email sent with
 * tracking off can never register an open, so counting it against the open rate
 * would drag the number down for a reason that has nothing to do with the
 * recipient. Warmup and anything sent before tracking existed carry no
 * `meta.tracking`, so `readTracking` returns null for them and they fall out of
 * `tracked` on their own — they still count towards `sent`.
 */
export function summariseEngagement(
  metas: (Record<string, unknown> | null | undefined)[],
): EngagementSummary {
  let sent = 0;
  let tracked = 0;
  let clickTracked = 0;
  let openedEmails = 0;
  let clickedEmails = 0;
  let opens = 0;
  let clicks = 0;

  for (const meta of metas) {
    sent += 1;
    const summary = readTracking(meta);
    if (!summary || !summary.tracked) continue;

    tracked += 1;
    if ((meta?.tracking as TrackingRecord | undefined)?.mode === "opens_and_clicks") {
      clickTracked += 1;
    }
    opens += summary.opens;
    clicks += summary.clicks;
    if (summary.opens > 0) openedEmails += 1;
    if (summary.clicks > 0) clickedEmails += 1;
  }

  const rate = (numerator: number, denominator: number) =>
    denominator <= 0 ? 0 : numerator / denominator;

  return {
    sent,
    tracked,
    clickTracked,
    openedEmails,
    clickedEmails,
    opens,
    clicks,
    openRate: rate(openedEmails, tracked),
    clickRate: rate(clickedEmails, tracked),
  };
}

/** "Opened 3× · first 20 Aug 14:22 · 1 click" — one line for a timeline row. */
export function describeTracking(
  summary: TrackingSummary | null,
  format: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string {
  if (!summary) return "";
  if (!summary.tracked) return "Not tracked";
  if (summary.opens === 0) return "Not opened yet";

  const parts = [
    summary.opens === 1 ? "Opened once" : `Opened ${summary.opens}×`,
  ];
  if (summary.firstOpenAt) parts.push(`first ${format(summary.firstOpenAt)}`);
  if (summary.clicks > 0) {
    parts.push(summary.clicks === 1 ? "1 click" : `${summary.clicks} clicks`);
  }
  return parts.join(" · ");
}

/**
 * Rolls several messages up into one figure per contact or per step.
 *
 * Opens are summed rather than maxed: three opens of step 1 and two of step 2
 * is a publisher who has looked five times, which is the signal worth having.
 * `openedAny` answers the separate question — did this person ever open
 * anything — which a sum cannot, since a single 5 and five 1s look the same.
 */
export function rollUpTracking(summaries: (TrackingSummary | null)[]): {
  opens: number;
  clicks: number;
  openedAny: boolean;
  clickedAny: boolean;
  firstOpenAt: string | null;
  lastOpenAt: string | null;
  tracked: number;
} {
  let opens = 0;
  let clicks = 0;
  let tracked = 0;
  let firstOpenAt: string | null = null;
  let lastOpenAt: string | null = null;

  for (const summary of summaries) {
    if (!summary || !summary.tracked) continue;
    tracked += 1;
    opens += summary.opens;
    clicks += summary.clicks;
    if (summary.firstOpenAt && (!firstOpenAt || summary.firstOpenAt < firstOpenAt)) {
      firstOpenAt = summary.firstOpenAt;
    }
    if (summary.lastOpenAt && (!lastOpenAt || summary.lastOpenAt > lastOpenAt)) {
      lastOpenAt = summary.lastOpenAt;
    }
  }

  return {
    opens,
    clicks,
    openedAny: opens > 0,
    clickedAny: clicks > 0,
    firstOpenAt,
    lastOpenAt,
    tracked,
  };
}
