/**
 * One place for how this app shows dates and times.
 *
 * The workspace runs on Pakistan time. Server components render on Vercel, whose
 * process clock is UTC, so a bare `new Date(x).toLocaleString()` in a server
 * component shows UTC — hours off from what the user expects. Every displayed
 * timestamp goes through here with an explicit `Asia/Karachi` zone, so the
 * server and the user's own browser agree.
 *
 * This is display only. Scheduling and the daily-limit counter still reason in
 * UTC on purpose (see `campaigns/schedule.ts` and `mailboxes/volume.ts`); those
 * paths never call these helpers.
 */

export const DEFAULT_TIMEZONE = "Asia/Karachi";

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date + time, in Pakistan time. e.g. "21 Aug 2026, 02:14 pm". */
export function fmtDateTime(value: DateInput, fallback = "—"): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString("en-GB", {
    timeZone: DEFAULT_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/** Date only, in Pakistan time. e.g. "21 Aug 2026". */
export function fmtDate(value: DateInput, fallback = "—"): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString("en-GB", {
    timeZone: DEFAULT_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
