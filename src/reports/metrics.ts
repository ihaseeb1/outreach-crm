/**
 * Reporting maths. Pure functions so the rates — the numbers you would actually
 * make decisions on — are covered by tests rather than assumed.
 */

export interface DailyPoint {
  date: string;
  sent: number;
  replies: number;
  bounces: number;
}

export interface OutreachTotals {
  sent: number;
  replies: number;
  bounces: number;
  replyRate: number;
  bounceRate: number;
}

export function totals(points: DailyPoint[]): OutreachTotals {
  const sent = sum(points, (point) => point.sent);
  const replies = sum(points, (point) => point.replies);
  const bounces = sum(points, (point) => point.bounces);

  return {
    sent,
    replies,
    bounces,
    replyRate: ratio(replies, sent),
    bounceRate: ratio(bounces, sent),
  };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/** Guards the empty case — a 0/0 rate is 0, not NaN. */
export function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Buckets timestamps into a dense day series, so a quiet day shows as zero
 * rather than being missing from the chart.
 */
export function buildDailySeries(
  days: number,
  input: {
    sent: string[];
    replies: string[];
    bounces: string[];
  },
  today: Date = new Date(),
): DailyPoint[] {
  const series: DailyPoint[] = [];
  const index = new Map<string, DailyPoint>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today.getTime() - offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const point: DailyPoint = { date: day, sent: 0, replies: 0, bounces: 0 };
    series.push(point);
    index.set(day, point);
  }

  const tally = (timestamps: string[], key: "sent" | "replies" | "bounces") => {
    for (const timestamp of timestamps) {
      const day = timestamp.slice(0, 10);
      const point = index.get(day);
      if (point) point[key] += 1;
    }
  };

  tally(input.sent, "sent");
  tally(input.replies, "replies");
  tally(input.bounces, "bounces");

  return series;
}

export interface NichePrice {
  niche: string;
  price: number;
  status: string;
}

export interface NicheSummary {
  niche: string;
  quoted: number;
  won: number;
  wonValue: number;
  averagePrice: number;
  lowestPrice: number;
  highestPrice: number;
}

const WON_STATUSES = new Set(["agreed", "ordered", "live"]);

/**
 * Value by niche.
 *
 * "Won" counts agreed, ordered and live — a deal you have committed to is real
 * money whether or not the link is published yet. `quoted` counts every price
 * seen, so you can tell a niche nobody sells from one you never buy.
 */
export function summariseByNiche(prices: NichePrice[]): NicheSummary[] {
  const groups = new Map<string, NichePrice[]>();
  for (const price of prices) {
    const key = price.niche.trim();
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(price);
    groups.set(key, list);
  }

  const summaries: NicheSummary[] = [];
  for (const [niche, items] of groups) {
    const values = items.map((item) => item.price);
    const wonItems = items.filter((item) => WON_STATUSES.has(item.status));

    summaries.push({
      niche,
      quoted: items.length,
      won: wonItems.length,
      wonValue: wonItems.reduce((total, item) => total + item.price, 0),
      averagePrice: values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : 0,
      lowestPrice: values.length ? Math.min(...values) : 0,
      highestPrice: values.length ? Math.max(...values) : 0,
    });
  }

  return summaries.sort((a, b) => b.wonValue - a.wonValue || b.quoted - a.quoted);
}

export interface FunnelInput {
  contacted: number;
  replied: number;
  dealsLogged: number;
  dealsWon: number;
}

export interface FunnelStep {
  label: string;
  count: number;
  /** Conversion from the previous step. */
  rate: number;
}

export function buildFunnel(input: FunnelInput): FunnelStep[] {
  return [
    { label: "Contacted", count: input.contacted, rate: 1 },
    { label: "Replied", count: input.replied, rate: ratio(input.replied, input.contacted) },
    {
      label: "Deal logged",
      count: input.dealsLogged,
      rate: ratio(input.dealsLogged, input.replied),
    },
    {
      label: "Won",
      count: input.dealsWon,
      rate: ratio(input.dealsWon, input.dealsLogged),
    },
  ];
}
