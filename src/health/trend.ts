/**
 * Reading a mailbox's reputation trend, in plain English.
 *
 * A single score tells you where a mailbox is; the trend tells you where it is
 * going, which is what you actually need to act before a box tips into the
 * spam folder. Pure so the thresholds are covered by the smoke tests.
 */

export interface HealthPoint {
  date: string;
  reputation_score: number;
  bounce_rate: number;
}

export type TrendSeverity = "ok" | "watch" | "alert";

export interface HealthTrend {
  latest: number;
  previous: number | null;
  /** latest − previous; null when there is only one check. */
  delta: number | null;
  severity: TrendSeverity;
  /** One line a beginner can act on. */
  message: string;
}

const ALERT_SCORE = 60;
const WATCH_SCORE = 80;
const ALERT_DROP = 10;
const WATCH_DROP = 5;

/**
 * `points` newest-first (the order the Deliverability query returns). Compares
 * the latest check with the one before it, and weighs both the absolute score
 * and how fast it is moving — a box at 85 falling 12 points in a day is worth
 * flagging even though 85 on its own looks fine.
 */
export function healthTrend(points: HealthPoint[]): HealthTrend | null {
  if (points.length === 0) return null;

  const latest = points[0]!.reputation_score;
  const previous = points.length > 1 ? points[1]!.reputation_score : null;
  const delta = previous === null ? null : latest - previous;
  const drop = delta === null ? 0 : -delta;

  let severity: TrendSeverity = "ok";
  if (latest < ALERT_SCORE || drop >= ALERT_DROP) severity = "alert";
  else if (latest < WATCH_SCORE || drop >= WATCH_DROP) severity = "watch";

  return { latest, previous, delta, severity, message: describe(latest, delta, severity) };
}

function describe(latest: number, delta: number | null, severity: TrendSeverity): string {
  const move =
    delta === null
      ? "First check recorded"
      : delta > 0
        ? `Up ${delta} since the last check`
        : delta < 0
          ? `Down ${-delta} since the last check`
          : "Flat since the last check";

  if (severity === "alert") {
    return `${move}. Score ${latest}/100 — act now: pause outreach, keep warmup running, and check SPF/DKIM/DMARC and the bounce rate below.`;
  }
  if (severity === "watch") {
    return `${move}. Score ${latest}/100 — keep an eye on it. Let warmup keep climbing and avoid raising the daily limit until it recovers.`;
  }
  return `${move}. Score ${latest}/100 — healthy.`;
}

export interface MailboxTrendAlert {
  mailboxId: string;
  email: string;
  trend: HealthTrend;
}

/** The declining mailboxes worth surfacing at the top of a page, worst first. */
export function decliningMailboxes(
  alerts: MailboxTrendAlert[],
): MailboxTrendAlert[] {
  const rank: Record<TrendSeverity, number> = { alert: 0, watch: 1, ok: 2 };
  return alerts
    .filter((alert) => alert.trend.severity !== "ok")
    .sort(
      (a, b) =>
        rank[a.trend.severity] - rank[b.trend.severity] ||
        a.trend.latest - b.trend.latest,
    );
}
