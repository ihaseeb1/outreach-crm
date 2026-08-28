import Link from "next/link";

import {
  ReportMailboxTable,
  type ReportMailboxRow,
} from "@/components/report-mailbox-table";
import { ReportRangePicker } from "@/components/report-range-picker";
import { VolumeChart, type VolumePoint } from "@/components/volume-chart";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import { MAX_REPORT_MAILBOX_WINDOW } from "@/mailboxes/volume";
import {
  buildFunnel,
  formatPercent,
  summariseByNiche,
  type NichePrice,
} from "@/reports/metrics";
import { loadReportData } from "@/reports/data";
import {
  parseReportBucket,
  parseReportRange,
  resolveReportRange,
} from "@/reports/ranges";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();
  const workspaceId = session.workspace.id;

  const params = await searchParams;
  const range = resolveReportRange(
    parseReportRange(params.range),
    new Date(),
    parseReportBucket(params.bucket),
  );
  const since = range.since;

  // The mailbox table has its own windows, up to 3 months, and they are
  // independent of the page range: picking "7 days" at the top must not empty
  // the "3 months" column below it.
  const mailboxSince = new Date(
    Math.min(
      Date.parse(since),
      Date.now() - MAX_REPORT_MAILBOX_WINDOW * 86_400_000,
    ),
  ).toISOString();

  const [
    report,
    { data: mailboxRows },
    { data: healthRows },
    { data: dealRows },
    contactedResult,
    lifetime,
  ] = await Promise.all([
    // Headline figures, the chart, and per-mailbox volume — all counted in the
    // database (migration 0013) so nothing is capped at 1000 rows any more.
    loadReportData(supabase, {
      workspaceId,
      since,
      days: range.days,
      bucket: range.bucket,
      mailboxSince,
    }),
    supabase
      .from("mailboxes")
      .select("id, email, health_status, sent_today, daily_limit")
      .eq("workspace_id", workspaceId),
    supabase
      .from("mailbox_health")
      .select("mailbox_id, reputation_score, bounce_rate, date")
      .eq("workspace_id", workspaceId)
      .order("date", { ascending: false })
      .limit(200),
    supabase
      .from("deals")
      .select("id, status, currency, deal_prices(niche, price)")
      .eq("workspace_id", workspaceId)
      .limit(5000),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .neq("pipeline_stage", "new"),
    loadLifetimeTotals(supabase, workspaceId),
  ]);

  const series = report.series;
  const summary = report.summary;
  const engagement = report.engagement;
  const volumes = report.volumes;

  const deals = (dealRows ?? []) as unknown as {
    id: string;
    status: string;
    deal_prices: { niche: string; price: number }[];
  }[];

  const nichePrices: NichePrice[] = deals.flatMap((deal) =>
    (deal.deal_prices ?? []).map((price) => ({
      niche: price.niche,
      price: Number(price.price),
      status: deal.status,
    })),
  );
  const niches = summariseByNiche(nichePrices);

  const wonDeals = deals.filter((deal) =>
    ["agreed", "ordered", "live"].includes(deal.status),
  );

  const funnel = buildFunnel({
    contacted: contactedResult.count ?? 0,
    replied: summary.replies,
    dealsLogged: deals.length,
    dealsWon: wonDeals.length,
  });

  const mailboxes = (mailboxRows ?? []) as {
    id: string;
    email: string;
    health_status: string;
    sent_today: number;
    daily_limit: number;
  }[];

  const latestHealth = new Map<string, { reputation_score: number; bounce_rate: number }>();
  for (const row of (healthRows ?? []) as {
    mailbox_id: string;
    reputation_score: number;
    bounce_rate: number;
  }[]) {
    if (!latestHealth.has(row.mailbox_id)) latestHealth.set(row.mailbox_id, row);
  }

  const mailboxRowsForTable: ReportMailboxRow[] = mailboxes.map((mailbox) => {
    const health = latestHealth.get(mailbox.id);
    return {
      id: mailbox.id,
      email: mailbox.email,
      healthStatus: mailbox.health_status,
      reputationScore: health ? health.reputation_score : null,
      bounceRate: health ? Number(health.bounce_rate) : null,
      sentToday: mailbox.sent_today,
      dailyLimit: mailbox.daily_limit,
    };
  });

  const volumePoints: VolumePoint[] = series.map((point) => ({
    key: point.date,
    label: bucketLabel(point, range.bucket),
    sent: point.sent,
    replies: point.replies,
    bounces: point.bounces,
  }));

  // Averaged over buckets that have actually happened. Including a month that
  // is three days old alongside eleven complete ones drags the average down and
  // makes a steady period look like a decline.
  const completeBuckets = series.filter((point) => point.sent > 0).length;
  const perBucket =
    completeBuckets === 0
      ? "0"
      : (summary.sent / completeBuckets).toFixed(
          summary.sent / completeBuckets >= 10 ? 0 : 1,
        );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="hint mt-1">
            {range.label}
            {range.key === "ytd" && ` — ${range.days} days so far`}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            className="text-sm text-[var(--color-brand)] hover:underline"
            href={`/api/reports/export?range=${range.key}&bucket=${range.bucket}`}
          >
            Export CSV
          </a>
          <ReportRangePicker value={range.key} bucket={range.bucket} />
        </div>
      </div>

      {/* All-time monitor. Counted in the database, so these keep climbing past
          1000 — the running totals for the whole CRM, independent of the range
          picker above. */}
      <section className="card card-pad">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">All-time totals</h2>
          <span className="hint">Live count · no limit</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Monitor label="Emails sent" value={lifetime.sent} color="var(--color-brand)" />
          <Monitor label="Replies" value={lifetime.replies} color="var(--color-ok)" />
          <Monitor label="Bounces" value={lifetime.bounces} color="var(--color-danger)" />
          <Monitor label="Contacts" value={lifetime.contacts} color="var(--color-ink)" />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Emails sent" value={summary.sent.toLocaleString()} />
        <Stat
          label="Replies"
          value={summary.replies.toLocaleString()}
          note={formatPercent(summary.replyRate)}
        />
        <Stat
          label="Bounces"
          value={summary.bounces.toLocaleString()}
          note={formatPercent(summary.bounceRate)}
          tone={summary.bounceRate >= 0.04 ? "warn" : undefined}
        />
        <Stat
          label="Deals won"
          value={wonDeals.length.toLocaleString()}
          note={`${deals.length} logged`}
        />
      </div>

      <section className="card card-pad space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{BUCKET_HEADINGS[range.bucket]}</h2>
          <p className="hint">
            {summary.sent.toLocaleString()} sent over {series.length}{" "}
            {BUCKET_NOUNS[range.bucket]}
            {series.length === 1 ? "" : "s"} · {perBucket} per{" "}
            {BUCKET_NOUNS[range.bucket]} on average
          </p>
        </div>
        <VolumeChart points={volumePoints} bucketNoun={BUCKET_NOUNS[range.bucket] ?? range.bucket} />
        <p className="hint">
          Each column is one {BUCKET_NOUNS[range.bucket]}. Hover for the exact
          sent, reply and bounce numbers. {BUCKET_NOTES[range.bucket]}
          {!range.bucketIsExplicit &&
            range.bucket === "week" &&
            " Grouped into weeks automatically for a range this long — 365 daily bars would each be a sliver."}
        </p>
      </section>

      <section className="card card-pad space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Opens &amp; clicks</h2>
          <p className="hint">
            {engagement.tracked > 0
              ? `Across the ${engagement.tracked.toLocaleString()} tracked email${engagement.tracked === 1 ? "" : "s"} sent in this period` +
                (engagement.clickTracked > 0
                  ? ` — ${engagement.clickTracked.toLocaleString()} with click tracking`
                  : "")
              : "No tracked emails sent in this period"}
          </p>
        </div>

        {engagement.tracked === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            Nothing to show yet. Opens and clicks are only recorded on emails
            sent while tracking is on — check the tracking mode in Settings, and
            note that mail sent before tracking was added reads as untracked
            rather than unopened.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Emails opened"
                value={engagement.openedEmails.toLocaleString()}
                note={`${formatPercent(engagement.openRate)} of tracked`}
              />
              <Stat
                label="Total opens"
                value={engagement.opens.toLocaleString()}
                note="counting repeat opens"
              />
              <Stat
                label="Emails clicked"
                value={engagement.clickedEmails.toLocaleString()}
                note={`${formatPercent(engagement.clickRate)} of tracked`}
              />
              <Stat
                label="Total clicks"
                value={engagement.clicks.toLocaleString()}
                note={`${engagement.clickTracked.toLocaleString()} of ${engagement.tracked.toLocaleString()} tracked for clicks`}
              />
            </div>
            <p className="hint">
              Opens are approximate — images blocked means no open is recorded,
              and a privacy proxy (Apple Mail, some Gmail setups) can fetch the
              pixel before anyone reads the message. Rates are out of emails sent
              with tracking on, not every email sent.
            </p>
          </>
        )}
      </section>

      <section className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Funnel</h2>
        <div className="space-y-2">
          {funnel.map((step) => (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-sm">{step.label}</span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-[var(--color-canvas)]">
                <div
                  className="h-full rounded bg-[var(--color-brand)]"
                  style={{
                    width: `${Math.max(2, Math.min(100, (step.count / Math.max(1, funnel[0]?.count ?? 1)) * 100))}%`,
                  }}
                />
              </div>
              <span className="w-28 shrink-0 text-right text-sm">
                {step.count.toLocaleString()}{" "}
                <span className="hint">{formatPercent(step.rate, 0)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <ReportMailboxTable mailboxes={mailboxRowsForTable} volumes={volumes} />

      <section className="card">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="text-sm font-semibold">Value by niche</h2>
          <Link className="text-sm text-[var(--color-brand)] hover:underline" href="/deals">
            All deals →
          </Link>
        </div>
        {niches.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            No deals logged yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Niche</th>
                  <th>Quoted</th>
                  <th>Won</th>
                  <th>Won value</th>
                  <th>Average</th>
                  <th>Range</th>
                </tr>
              </thead>
              <tbody>
                {niches.map((niche) => (
                  <tr key={niche.niche}>
                    <td className="font-medium">{niche.niche}</td>
                    <td>{niche.quoted}</td>
                    <td>{niche.won}</td>
                    <td>{Math.round(niche.wonValue).toLocaleString()}</td>
                    <td>{Math.round(niche.averagePrice).toLocaleString()}</td>
                    <td>
                      {Math.round(niche.lowestPrice).toLocaleString()} –{" "}
                      {Math.round(niche.highestPrice).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The whole-CRM running totals. Each is an exact `count` — PostgREST returns
 * the number in a header and never the rows, so these are immune to the row cap
 * and keep climbing without limit. This is the "monitor how many it has sent"
 * figure the range picker above deliberately does not answer.
 */
async function loadLifetimeTotals(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  workspaceId: string,
): Promise<{ sent: number; replies: number; bounces: number; contacts: number }> {
  const [sent, replies, bounces, contacts] = await Promise.all([
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("direction", "outbound")
      .eq("status", "sent"),
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("direction", "inbound")
      .eq("is_bounce", false)
      .eq("is_auto_reply", false),
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("direction", "inbound")
      .eq("is_bounce", true),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
  ]);

  return {
    sent: sent.count ?? 0,
    replies: replies.count ?? 0,
    bounces: bounces.count ?? 0,
    contacts: contacts.count ?? 0,
  };
}

function Monitor({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div>
      <p className="hint">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums" style={{ color }}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

const BUCKET_HEADINGS: Record<string, string> = {
  day: "Daily volume",
  week: "Weekly volume",
  month: "Monthly volume",
};

const BUCKET_NOUNS: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
};

const BUCKET_NOTES: Record<string, string> = {
  day: "One bar a day.",
  week: "One bar a week, ending today rather than on a Monday.",
  month: "One bar a calendar month — the first and last may be part months.",
};

/**
 * What a bar covers, written the way the grouping means it.
 *
 * A monthly bar labelled with its first and last dates is technically right and
 * useless to read; it wants to say "August 2026", with the day range only when
 * the month is a partial one.
 */
function bucketLabel(
  point: { date: string; endDate: string; days: number },
  bucket: string,
): string {
  if (bucket === "month") {
    const month = new Date(`${point.date}T00:00:00Z`).toLocaleString(undefined, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const daysInMonth = new Date(
      Date.UTC(
        Number(point.date.slice(0, 4)),
        Number(point.date.slice(5, 7)),
        0,
      ),
    ).getUTCDate();
    return point.days === daysInMonth
      ? month
      : `${month} (${point.date.slice(8)}–${point.endDate.slice(8)})`;
  }

  return point.date === point.endDate
    ? point.date
    : `${point.date} – ${point.endDate}`;
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "warn";
}) {
  return (
    <div className="card card-pad">
      <p className="hint">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {note && (
        <p
          className={`hint ${tone === "warn" ? "text-[var(--color-warn)]" : ""}`}
        >
          {note}
        </p>
      )}
    </div>
  );
}
