/**
 * One place for how this app shows dates and times.
 *
 * The workspace runs on Pakistan time. Server components render on Vercel, whose
 * process clock is UTC, so a bare `new Date(x).toLocaleString()` in a server
 * component shows UTC — hours off from what the user expects. Every displayed
 * timestamp goes through here with an explicit `Asia/Karachi` zone, so the
 * server and the user's own browser agree.
 *
 * The daily-limit counter, the warmup ramp, health checks and every report
 * bucket also reason in this zone (see `workspaceDay`): the CRM's "day" starts
 * at 12:00 AM Pakistan Standard Time, not at UTC midnight.
 */

export const WORKSPACE_TIMEZONE = "Asia/Karachi";

export const DEFAULT_TIMEZONE = WORKSPACE_TIMEZONE;

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date + time, in the workspace timezone. e.g. "21 Aug 2026, 02:14 pm". */
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

/** Date only, in the workspace timezone. e.g. "21 Aug 2026". */
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

/**
 * The workspace calendar day ("YYYY-MM-DD") an instant falls on.
 *
 * This is the single definition of "today" for the whole app: the daily send
 * counter (`sent_today_date`), the warmup ramp marker, health-check markers,
 * report buckets and the volume "Today" view all use it, so they can never
 * disagree about when the day rolls over. It rolls at 12:00 AM Pakistan time.
 */
export function workspaceDay(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: WORKSPACE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Start of the workspace day containing `value`, as a UTC instant.
 *
 * Asia/Karachi is UTC+5 year-round (Pakistan abolished DST in 2009), so the
 * offset is a constant rather than a lookup.
 */
export function startOfWorkspaceDay(value: Date = new Date()): Date {
  const day = workspaceDay(value);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, date) - 5 * 3_600_000);
}
