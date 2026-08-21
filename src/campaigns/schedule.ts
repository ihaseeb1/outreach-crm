import { DEFAULT_TIMEZONE } from "@/lib/datetime";
import type { CampaignSettings } from "@/types/db";

/**
 * Send-window and delay maths. Pure functions — no I/O — so the smoke tests
 * cover the awkward cases (weekends, timezone offsets, midnight rollover).
 *
 * Compliance rule #7: sends look like a person typing, not a machine blasting.
 * That means business hours, chosen weekdays, and randomised gaps.
 */

export interface ResolvedWindow {
  startHour: number;
  endHour: number;
  days: number[];
  timezone: string;
}

const DEFAULTS: ResolvedWindow = {
  startHour: 9,
  endHour: 17,
  // Monday–Friday. 0 = Sunday.
  days: [1, 2, 3, 4, 5],
  timezone: DEFAULT_TIMEZONE,
};

export function resolveWindow(settings: CampaignSettings | null | undefined): ResolvedWindow {
  let startHour = clampHour(settings?.send_window_start, DEFAULTS.startHour, 0, 23);
  let endHour = clampHour(settings?.send_window_end, DEFAULTS.endHour, 1, 24);

  // An end at or before the start is an empty window — a campaign configured
  // that way would silently never send, so fall back to the whole default pair
  // rather than patching one half and leaving it still inverted.
  if (endHour <= startHour) {
    startHour = DEFAULTS.startHour;
    endHour = DEFAULTS.endHour;
  }

  const days =
    Array.isArray(settings?.send_days) && settings.send_days.length > 0
      ? settings.send_days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : DEFAULTS.days;

  return {
    startHour,
    endHour,
    days: days.length > 0 ? days : DEFAULTS.days,
    timezone: settings?.timezone || DEFAULTS.timezone,
  };
}

function clampHour(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

interface ZonedParts {
  weekday: number;
  hour: number;
  minute: number;
}

/** Local wall-clock weekday/hour for an instant, in the campaign's timezone. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const parts = formatter.formatToParts(date);
  const lookup = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdayNames.indexOf(lookup("weekday"));
  // "24" appears at midnight in some ICU versions.
  const hour = Number.parseInt(lookup("hour"), 10) % 24;

  return {
    weekday: weekday === -1 ? date.getUTCDay() : weekday,
    hour: Number.isFinite(hour) ? hour : date.getUTCHours(),
    minute: Number.parseInt(lookup("minute"), 10) || 0,
  };
}

export function isWithinSendWindow(date: Date, window: ResolvedWindow): boolean {
  const { weekday, hour } = zonedParts(date, window.timezone);
  if (!window.days.includes(weekday)) return false;
  return hour >= window.startHour && hour < window.endHour;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * The first moment at or after `from` that falls inside the window.
 *
 * Steps forward in 15-minute increments rather than doing timezone arithmetic
 * by hand — DST transitions and half-hour offsets then come out right for free.
 */
export function nextWindowOpening(from: Date, window: ResolvedWindow): Date {
  if (isWithinSendWindow(from, window)) return from;

  const limit = MAX_LOOKAHEAD_DAYS * 24 * 4;
  let candidate = new Date(
    Math.ceil(from.getTime() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES,
  );

  for (let i = 0; i < limit; i += 1) {
    if (isWithinSendWindow(candidate, window)) return candidate;
    candidate = new Date(candidate.getTime() + FIFTEEN_MINUTES);
  }

  // No configuration should reach this, but never return an invalid date.
  return from;
}

export interface NextSendInput {
  from: Date;
  delayDays: number;
  window: ResolvedWindow;
  /** Injected in tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * When the next step of a sequence should go out: wait the configured days,
 * scatter it across the sending window so follow-ups never arrive in lockstep,
 * then pull it forward to the next open window.
 */
export function nextSendAt(input: NextSendInput): Date {
  const random = input.random ?? Math.random;
  const base = new Date(
    input.from.getTime() + Math.max(0, input.delayDays) * 24 * 60 * 60 * 1000,
  );

  // Spread within the window's span so two contacts on the same step do not
  // fire at the same second.
  const spanHours = input.window.endHour - input.window.startHour;
  const jitterMs = Math.floor(random() * spanHours * 60 * 60 * 1000);
  const jittered = new Date(base.getTime() + jitterMs);

  return nextWindowOpening(jittered, input.window);
}

/**
 * Randomised gap between two consecutive sends from the same mailbox.
 * Keeps a mailbox from firing a burst even when many contacts are due.
 */
export function randomGapMs(
  minSeconds: number,
  maxSeconds: number,
  random: () => number = Math.random,
): number {
  const min = Math.max(0, minSeconds);
  const max = Math.max(min, maxSeconds);
  return Math.floor((min + random() * (max - min)) * 1000);
}

/** True when enough time has passed since a mailbox's previous send. */
export function mailboxIsRested(
  lastSendAt: string | null,
  minSeconds: number,
  maxSeconds: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): boolean {
  if (!lastSendAt) return true;
  const elapsed = now.getTime() - new Date(lastSendAt).getTime();
  return elapsed >= randomGapMs(minSeconds, maxSeconds, random);
}
