/**
 * Sent volume per mailbox over 7 / 14 / 30 days.
 *
 * The mailboxes page only ever showed "sent today", which is enough to see a
 * mailbox is at its cap and useless for seeing whether it has been sending at
 * all. Everything here is pure so it can be tested without a database; the page
 * hands it rows straight from `messages`.
 *
 * Warmup counts **inside** the daily limit, not on top of it: a mailbox set to 6
 * a day sends six emails in total, warmup included. So the total is the number
 * that matters and warmup is reported as a share of it, never as a second figure
 * to be added on.
 */

export const VOLUME_WINDOWS = [7, 14, 30] as const;

export type VolumeWindow = (typeof VOLUME_WINDOWS)[number];

/**
 * "Today" is a fourth view, and it is not "the last 24 hours".
 *
 * The daily limit resets on the UTC date — `sent_today_date` is written as
 * `toISOString().slice(0, 10)` everywhere in the app — so today's count has to
 * use the same boundary. A rolling 24 hours would disagree with the "Sent today"
 * figure on the same card every evening, and the one that would look wrong is
 * this one.
 */
export const TODAY = "today" as const;

export type VolumeKey = VolumeWindow | number | typeof TODAY;

/** What the mailboxes page offers, in the order it offers it. */
export const VOLUME_VIEWS: readonly { key: VolumeKey; label: string }[] = [
  { key: TODAY, label: "Today" },
  ...VOLUME_WINDOWS.map((days) => ({ key: days as VolumeKey, label: `${days} days` })),
];

/** The UTC date a timestamp falls on — the same boundary as the daily limit. */
export function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Widest window, so the page and this module agree on how far back to read. */
export const MAX_VOLUME_WINDOW = Math.max(...VOLUME_WINDOWS) as VolumeWindow;

/**
 * The windows are a parameter rather than a constant because Reports asks the
 * same question over a longer span — 7 / 14 / 30 days plus 2 and 3 months. Two
 * copies of this bucketing would be two places for "does 30 days include a send
 * from exactly 30 days ago" to be answered differently.
 */
export const REPORT_MAILBOX_WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
] as const;

export const MAX_REPORT_MAILBOX_WINDOW = Math.max(
  ...REPORT_MAILBOX_WINDOWS.map((window) => window.days),
);

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

/**
 * Keyed by window length in days, plus `today`.
 *
 * `today` is optional in the type because a caller can hand a hand-built volume
 * to `countsFor`, and every lookup already tolerates a window that was never
 * computed.
 */
export interface MailboxVolume {
  [days: number]: WindowCounts;
  today?: WindowCounts;
}

const DAY_MS = 86_400_000;

export function emptyVolume(
  windows: readonly number[] = VOLUME_WINDOWS,
): MailboxVolume {
  const volume: MailboxVolume = { today: { outreach: 0, warmup: 0 } };
  for (const window of windows) volume[window] = { outreach: 0, warmup: 0 };
  return volume;
}

/**
 * Counts for one window, zeroed when there are none.
 *
 * Since the windows became a parameter, a lookup can miss two ways: no sends
 * from that mailbox at all, or a window this summary was never asked to compute.
 * Both mean "nothing to show", and a caller that has to spell that out at every
 * use site will eventually forget at one of them.
 */
export function countsFor(
  volume: MailboxVolume | undefined,
  days: VolumeKey,
): WindowCounts {
  const counts = days === TODAY ? volume?.today : volume?.[days];
  return counts ?? { outreach: 0, warmup: 0 };
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
  windows: readonly number[] = VOLUME_WINDOWS,
): Record<string, MailboxVolume> {
  const nowMs = now.getTime();
  const widest = Math.max(...windows);
  const today = utcDay(now);
  const byMailbox: Record<string, MailboxVolume> = {};

  for (const row of rows) {
    if (!row.mailbox_id || !row.sent_at) continue;

    const at = Date.parse(row.sent_at);
    if (Number.isNaN(at)) continue;

    // Negative for a future timestamp — clock skew still counts as "just now"
    // rather than being dropped.
    const ageDays = (nowMs - at) / DAY_MS;
    if (ageDays > widest) continue;

    // Every send records its kind; anything else is real outreach, so an older
    // row with no kind is never miscounted as warmup.
    const bucket = row.meta?.kind === "warmup" ? "warmup" : "outreach";

    const volume = (byMailbox[row.mailbox_id] ??= emptyVolume(windows));

    // Counted from the date, not from the age in days: a send at 23:00 UTC and
    // one at 01:00 the next morning are two hours apart and belong to different
    // days, which is exactly how the daily limit sees them.
    // Re-derived from the parsed timestamp rather than sliced off the string:
    // Postgres hands back an offset ("+00:00" today, but a session in another
    // zone would not), and the date has to be the UTC one either way.
    if (utcDay(new Date(at)) === today) {
      const counts = volume.today;
      if (counts) counts[bucket] += 1;
    }

    for (const window of windows) {
      // Present by construction — emptyVolume seeded exactly these keys.
      const counts = volume[window];
      if (counts && ageDays <= window) counts[bucket] += 1;
    }
  }

  return byMailbox;
}

/** One decimal, because "0 a day" and "0.4 a day" are different situations. */

export function perDay(total: number, days: number): string {
  return (total / days).toFixed(1);
}
