/**
 * Sent volume per mailbox over 7 / 14 / 30 days.
 *
 * The mailboxes page only ever showed "sent today", which is enough to see a
 * mailbox is at its cap and useless for seeing whether it has been sending at
 * all. Everything here is pure so it can be tested without a database; the page
 * hands it rows straight from `messages`.
 *
 * Warmup and real outreach are counted separately. They share one daily budget,
 * so a mailbox reading "5 / 5 today" with three real sends this week is doing
 * exactly what it should — but only if both numbers are visible.
 */

export const VOLUME_WINDOWS = [7, 14, 30] as const;

export type VolumeWindow = (typeof VOLUME_WINDOWS)[number];

/** Widest window, so the page and this module agree on how far back to read. */
export const MAX_VOLUME_WINDOW = Math.max(...VOLUME_WINDOWS) as VolumeWindow;

/** The columns of `messages` this needs — nothing else is read. */
export interface SentRow {
  mailbox_id: string | null;
  sent_at: string | null;
  meta: { kind?: string | null } | null;
}

export interface WindowCounts {
  outreach: number;
  warmup: number;
}

export type MailboxVolume = Record<VolumeWindow, WindowCounts>;

const DAY_MS = 86_400_000;

export function emptyVolume(): MailboxVolume {
  return {
    7: { outreach: 0, warmup: 0 },
    14: { outreach: 0, warmup: 0 },
    30: { outreach: 0, warmup: 0 },
  };
}

/**
 * Counts outbound sends per mailbox, per window.
 *
 * Windows are nested rather than exclusive: an email sent three days ago is in
 * all three counts. "Last 14 days" reading lower than "last 7" would be a
 * puzzle, not a fact.
 *
 * Returned as a plain object so it can be passed to a client component as-is.
 */
export function summariseVolume(
  rows: SentRow[],
  now: Date = new Date(),
): Record<string, MailboxVolume> {
  const nowMs = now.getTime();
  const byMailbox: Record<string, MailboxVolume> = {};

  for (const row of rows) {
    if (!row.mailbox_id || !row.sent_at) continue;

    const at = Date.parse(row.sent_at);
    if (Number.isNaN(at)) continue;

    // Negative for a future timestamp — clock skew still counts as "just now"
    // rather than being dropped.
    const ageDays = (nowMs - at) / DAY_MS;
    if (ageDays > MAX_VOLUME_WINDOW) continue;

    // Every send records its kind; anything else is real outreach, so an older
    // row with no kind is never miscounted as warmup.
    const bucket = row.meta?.kind === "warmup" ? "warmup" : "outreach";

    const volume = (byMailbox[row.mailbox_id] ??= emptyVolume());
    for (const window of VOLUME_WINDOWS) {
      if (ageDays <= window) volume[window][bucket] += 1;
    }
  }

  return byMailbox;
}

/** One decimal, because "0 a day" and "0.4 a day" are different situations. */
export function perDay(total: number, days: number): string {
  return (total / days).toFixed(1);
}
