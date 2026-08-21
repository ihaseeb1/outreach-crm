/**
 * The window a report covers.
 *
 * Reports used to be hardcoded to 30 days, which is the wrong length for both
 * of the questions people actually ask it: "is this week working" wants 7 days,
 * and "how did the year go" wants everything since January. So the window is a
 * URL parameter with a fixed menu behind it — a menu, not a free date picker,
 * because every option here maps to a single `gte` and stays cheap.
 *
 * Pure and dependency-free so the awkward one — year to date, whose length
 * changes every midnight — is covered by tests.
 */

export const REPORT_RANGE_KEYS = [
  "7",
  "14",
  "30",
  "90",
  "180",
  "365",
  "ytd",
] as const;

export type ReportRangeKey = (typeof REPORT_RANGE_KEYS)[number];

export const DEFAULT_REPORT_RANGE: ReportRangeKey = "30";

const LABELS: Record<ReportRangeKey, string> = {
  "7": "Last 7 days",
  "14": "Last 14 days",
  "30": "Last 30 days",
  "90": "Last 3 months",
  "180": "Last 6 months",
  "365": "Last 12 months",
  ytd: "Year to date",
};

/** Short forms for the picker itself, where the surrounding text says "last". */
const SHORT_LABELS: Record<ReportRangeKey, string> = {
  "7": "7 days",
  "14": "14 days",
  "30": "30 days",
  "90": "3 months",
  "180": "6 months",
  "365": "12 months",
  ytd: "Year to date",
};

export interface ReportRangeOption {
  key: ReportRangeKey;
  label: string;
  shortLabel: string;
}

export const REPORT_RANGE_OPTIONS: ReportRangeOption[] = REPORT_RANGE_KEYS.map(
  (key) => ({ key, label: LABELS[key], shortLabel: SHORT_LABELS[key] }),
);

/**
 * How the volume chart groups its bars.
 *
 * A window and a grouping are two different questions, and tying them together
 * meant one of them could never be asked. "Last 12 months" always came back as
 * weekly bars, so there was no way to see twelve monthly totals; "last 30 days"
 * was always daily, so there was no way to see it as four weeks. Both are
 * ordinary things to want, so the grouping is its own control.
 */
export const REPORT_BUCKETS = ["day", "week", "month"] as const;

export type ReportBucket = (typeof REPORT_BUCKETS)[number];

export const REPORT_BUCKET_LABELS: Record<ReportBucket, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

export function isReportBucket(value: unknown): value is ReportBucket {
  return (
    typeof value === "string" &&
    (REPORT_BUCKETS as readonly string[]).includes(value)
  );
}

/** Falls back to whatever the range would have chosen — this comes from a URL. */
export function parseReportBucket(value: unknown): ReportBucket | null {
  return isReportBucket(value) ? value : null;
}

export interface ResolvedRange extends ReportRangeOption {
  /** Days in the window, counting today. */
  days: number;
  /** ISO timestamp for the `gte` — midnight UTC on the window's first day. */
  since: string;
  /** How the volume chart should bucket: a bar a day, a week, or a month. */
  bucket: ReportBucket;
  /** True when the bucket was chosen by the reader rather than by the range. */
  bucketIsExplicit: boolean;
}

const DAY_MS = 86_400_000;

/** Anything past this many days becomes weekly bars — 365 daily ones are 1px. */
const WEEKLY_ABOVE_DAYS = 92;

export function isReportRangeKey(value: unknown): value is ReportRangeKey {
  return (
    typeof value === "string" &&
    (REPORT_RANGE_KEYS as readonly string[]).includes(value)
  );
}

/** Falls back to the default rather than throwing — this comes from a URL. */
export function parseReportRange(value: unknown): ReportRangeKey {
  return isReportRangeKey(value) ? value : DEFAULT_REPORT_RANGE;
}

/**
 * Turns a key into the window to query and chart.
 *
 * `since` is midnight UTC on the first day rather than "now minus N × 24h". The
 * chart buckets by UTC calendar day, so a mid-afternoon cutoff would give the
 * earliest bar only part of its traffic and make it look like a quiet day.
 *
 * Year to date is measured from 1 January in UTC. In August that is ~232 days;
 * on 1 January it is 1 day, which is correct and not an empty report.
 */
export function resolveReportRange(
  key: ReportRangeKey,
  now: Date = new Date(),
  bucket: ReportBucket | null = null,
): ResolvedRange {
  const days = key === "ytd" ? daysSinceJanuaryFirst(now) : Number(key);
  const startMs = startOfUtcDay(now) - (days - 1) * DAY_MS;

  return {
    key,
    label: LABELS[key],
    shortLabel: SHORT_LABELS[key],
    days,
    since: new Date(startMs).toISOString(),
    // An explicit choice always wins, including "daily over a year" — that is
    // an unreadable chart, but it is the reader's chart to make unreadable, and
    // the alternative is a control that silently ignores you.
    bucket: bucket ?? (days > WEEKLY_ABOVE_DAYS ? "week" : "day"),
    bucketIsExplicit: bucket !== null,
  };
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
}

function daysSinceJanuaryFirst(now: Date): number {
  const january = Date.UTC(now.getUTCFullYear(), 0, 1);
  return Math.floor((startOfUtcDay(now) - january) / DAY_MS) + 1;
}
