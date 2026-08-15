import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import {
  buildDailySeries,
  buildFunnel,
  formatPercent,
  summariseByNiche,
  totals,
  type NichePrice,
} from "@/reports/metrics";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

export default async function ReportsPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();
  const workspaceId = session.workspace.id;

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  const [
    { data: sentRows },
    { data: inboundRows },
    { data: mailboxRows },
    { data: healthRows },
    { data: dealRows },
    contactedResult,
  ] = await Promise.all([
    supabase
      .from("messages")
      .select("sent_at, mailbox_id")
      .eq("workspace_id", workspaceId)
      .eq("direction", "outbound")
      .eq("status", "sent")
      .gte("sent_at", since)
      .limit(20_000),
    supabase
      .from("messages")
      .select("received_at, is_bounce, is_auto_reply")
      .eq("workspace_id", workspaceId)
      .eq("direction", "inbound")
      .gte("received_at", since)
      .limit(20_000),
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
  ]);

  const sent = ((sentRows ?? []) as { sent_at: string | null }[])
    .map((row) => row.sent_at)
    .filter((value): value is string => Boolean(value));

  const inbound = (inboundRows ?? []) as {
    received_at: string | null;
    is_bounce: boolean;
    is_auto_reply: boolean;
  }[];

  const replies = inbound
    .filter((row) => !row.is_bounce && !row.is_auto_reply)
    .map((row) => row.received_at)
    .filter((value): value is string => Boolean(value));

  const bounces = inbound
    .filter((row) => row.is_bounce)
    .map((row) => row.received_at)
    .filter((value): value is string => Boolean(value));

  const series = buildDailySeries(WINDOW_DAYS, { sent, replies, bounces });
  const summary = totals(series);

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
    replied: new Set(replies).size ? replies.length : 0,
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

  const sentByMailbox = new Map<string, number>();
  for (const row of (sentRows ?? []) as { mailbox_id: string | null }[]) {
    if (!row.mailbox_id) continue;
    sentByMailbox.set(row.mailbox_id, (sentByMailbox.get(row.mailbox_id) ?? 0) + 1);
  }

  const peak = Math.max(1, ...series.map((point) => point.sent));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="hint mt-1">Last {WINDOW_DAYS} days.</p>
      </div>

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
        <h2 className="text-sm font-semibold">Daily volume</h2>
        <div className="flex h-32 items-end gap-0.5">
          {series.map((point) => (
            <div
              key={point.date}
              className="group relative flex-1"
              title={`${point.date}: ${point.sent} sent, ${point.replies} replies, ${point.bounces} bounces`}
            >
              <div
                className="w-full rounded-sm bg-[var(--color-brand)]"
                style={{ height: `${(point.sent / peak) * 100}%`, minHeight: point.sent ? 2 : 0 }}
              />
              {point.replies > 0 && (
                <div
                  className="w-full rounded-sm bg-[var(--color-ok)]"
                  style={{ height: `${(point.replies / peak) * 100}%`, minHeight: 2 }}
                />
              )}
            </div>
          ))}
        </div>
        <p className="hint">
          Blue is sent, green is replies. Hover a bar for the day&apos;s numbers.
        </p>
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

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Mailboxes
        </h2>
        {mailboxes.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            No mailboxes connected.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Health</th>
                  <th>Score</th>
                  <th>Sent ({WINDOW_DAYS}d)</th>
                  <th>Bounce rate</th>
                  <th>Today</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => {
                  const health = latestHealth.get(mailbox.id);
                  return (
                    <tr key={mailbox.id}>
                      <td className="font-medium">{mailbox.email}</td>
                      <td>{mailbox.health_status}</td>
                      <td>{health ? `${health.reputation_score}/100` : "—"}</td>
                      <td>{(sentByMailbox.get(mailbox.id) ?? 0).toLocaleString()}</td>
                      <td>
                        {health ? formatPercent(Number(health.bounce_rate)) : "—"}
                      </td>
                      <td>
                        {mailbox.sent_today} / {mailbox.daily_limit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
