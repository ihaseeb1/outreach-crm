import Link from "next/link";

import { ClearAutoPauseButton } from "@/components/clear-auto-pause";
import { RunJobButton } from "@/components/run-job-button";
import { WarmupControls, type WarmupState } from "@/components/warmup-controls";
import { fmtDateTime } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import {
  decliningMailboxes,
  healthTrend,
  type HealthTrend,
  type MailboxTrendAlert,
} from "@/health/trend";
import {
  emptyActivity,
  loadWarmupActivity,
  type WarmupActivity,
} from "@/warmup/activity";
import type { Mailbox, MailboxHealth, WarmupSettings } from "@/types/db";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  healthy: "bg-green-50 text-[var(--color-ok)]",
  warning: "bg-amber-50 text-[var(--color-warn)]",
  paused: "bg-red-50 text-[var(--color-danger)]",
};

const TREND_STYLES: Record<string, string> = {
  ok: "bg-green-50 text-[var(--color-ok)]",
  watch: "bg-amber-50 text-[var(--color-warn)]",
  alert: "bg-red-50 text-[var(--color-danger)]",
};

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export default async function DeliverabilityPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();
  const workspaceId = session.workspace.id;

  const [{ data: mailboxRows }, { data: warmupRows }, { data: healthRows }, activity] =
    await Promise.all([
      supabase
        .from("mailboxes")
        .select(
          "id, email, from_name, is_active, health_status, paused_reason, daily_limit, sent_today, sent_today_date",
        )
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true }),
      supabase
        .from("warmup_settings")
        .select("*")
        .eq("workspace_id", workspaceId),
      supabase
        .from("mailbox_health")
        .select("*")
        .eq("workspace_id", workspaceId)
        .order("date", { ascending: false })
        .limit(200),
      loadWarmupActivity(supabase, workspaceId),
    ]);

  const mailboxes = (mailboxRows ?? []) as Mailbox[];
  const warmup = new Map(
    ((warmupRows ?? []) as WarmupSettings[]).map((row) => [row.mailbox_id, row]),
  );

  // Newest first, so the first row per mailbox is the latest check.
  const health = (healthRows ?? []) as MailboxHealth[];
  const latestHealth = new Map<string, MailboxHealth>();
  const history = new Map<string, MailboxHealth[]>();
  for (const row of health) {
    if (!latestHealth.has(row.mailbox_id)) latestHealth.set(row.mailbox_id, row);
    const list = history.get(row.mailbox_id) ?? [];
    if (list.length < 14) list.push(row);
    history.set(row.mailbox_id, list);
  }

  // Per-mailbox trend (newest-first history), plus the declining ones to flag
  // at the top of the page.
  const trends = new Map<string, HealthTrend>();
  const alerts: MailboxTrendAlert[] = [];
  for (const mailbox of mailboxes) {
    const trend = healthTrend(history.get(mailbox.id) ?? []);
    if (!trend) continue;
    trends.set(mailbox.id, trend);
    alerts.push({ mailboxId: mailbox.id, email: mailbox.email, trend });
  }
  const declining = decliningMailboxes(alerts);

  const poolSize = mailboxes.filter((mailbox) => mailbox.is_active).length;
  const totals = activity.totals;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Deliverability</h1>
        <p className="hint mt-1">
          Warmup keeps your mailboxes trusted; health monitoring warns you before
          one gets into trouble.
        </p>
      </div>

      {declining.length > 0 && (
        <section className="card card-pad border-[var(--color-warn)] bg-amber-50/40">
          <h2 className="text-sm font-semibold">
            {declining.some((alert) => alert.trend.severity === "alert")
              ? "⚠ Mailboxes needing attention"
              : "Mailboxes to keep an eye on"}
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {declining.map((alert) => (
              <li key={alert.mailboxId} className="flex flex-wrap items-center gap-2">
                <span className={`badge ${TREND_STYLES[alert.trend.severity]}`}>
                  {alert.trend.latest}/100
                </span>
                <span className="font-medium">{alert.email}</span>
                <span className="hint">{alert.trend.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {poolSize < 2 && (
        <p className="card card-pad text-sm text-[var(--color-warn)]">
          Warmup works by having your mailboxes email each other, so it needs at
          least two.{" "}
          <Link className="text-[var(--color-brand)] hover:underline" href="/mailboxes">
            Connect another
          </Link>
          . The more you connect, the less repetitive the pattern looks.
        </p>
      )}

      {/* Warmup at a glance — the back-and-forth totals across every mailbox,
          today, in plain numbers. */}
      <section className="card card-pad space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Warmup today, all mailboxes</h2>
          <span className="hint">Resets at midnight UTC</span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Glance label="Sent" value={totals.sentToday} color="var(--color-brand)" />
          <Glance label="Received" value={totals.receivedToday} color="var(--color-ink)" />
          <Glance label="Replied" value={totals.repliedToday} color="var(--color-ok)" />
          <Glance
            label="Rescued from spam (7d)"
            value={totals.rescued7d}
            color="var(--color-warn)"
          />
        </div>
        <p className="hint">
          Every mailbox sends a few of these ordinary-looking emails to your other
          mailboxes each day, opens them, and replies to some — that back-and-forth
          is what tells inbox providers the account is a real one people use. It
          runs every day, weekends included, and counts against the same daily
          limit as your campaigns.
        </p>
        <div className="flex flex-wrap gap-4">
          <RunJobButton job="warmup" label="Run warmup now" limit={40} />
          <RunJobButton job="health" label="Run health check now" limit={10} />
        </div>
      </section>

      {mailboxes.length === 0 ? (
        <p className="card card-pad text-sm text-[var(--color-muted)]">
          No mailboxes connected yet.
        </p>
      ) : (
        <div className="space-y-4">
          {mailboxes.map((mailbox) => {
            const settings = warmup.get(mailbox.id);
            const latest = latestHealth.get(mailbox.id);
            const trend = (history.get(mailbox.id) ?? []).slice().reverse();
            const trendInfo = trends.get(mailbox.id);
            const act = activity.byMailbox.get(mailbox.id) ?? emptyActivity();

            const warmupState: WarmupState | null = settings
              ? {
                  enabled: settings.enabled,
                  current_daily_volume: settings.current_daily_volume,
                  target_daily_volume: settings.target_daily_volume,
                  ramp_increment: settings.ramp_increment,
                  reply_rate: Number(settings.reply_rate),
                }
              : null;

            return (
              <section key={mailbox.id} className="card card-pad space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{mailbox.email}</p>
                    <p className="hint">
                      {latest
                        ? `Last checked ${fmtDateTime(latest.checked_at)}`
                        : "Not checked yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {trendInfo && (
                      <span className={`badge ${TREND_STYLES[trendInfo.severity]}`}>
                        {trendInfo.delta === null
                          ? `${trendInfo.latest}/100`
                          : `${trendInfo.latest}/100 ${
                              trendInfo.delta > 0 ? "▲" : trendInfo.delta < 0 ? "▼" : "→"
                            }${trendInfo.delta !== 0 ? Math.abs(trendInfo.delta) : ""}`}
                      </span>
                    )}
                    <span className={`badge ${STATUS_STYLES[mailbox.health_status] ?? ""}`}>
                      {mailbox.health_status}
                    </span>
                  </div>
                </div>

                {mailbox.health_status === "paused" && (
                  <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">
                    <p>Auto-paused{mailbox.paused_reason ? `: ${mailbox.paused_reason}` : "."}</p>
                    <p className="mt-1 text-[var(--color-muted)]">
                      Campaign sending is stopped, but warmup keeps running below so
                      the mailbox can recover. Resume sending once it looks healthy
                      again.
                    </p>
                    <ClearAutoPauseButton mailboxId={mailbox.id} />
                  </div>
                )}

                {/* The per-mailbox back-and-forth. */}
                <div className="rounded-md bg-[var(--color-canvas)] px-3 py-2.5">
                  <p className="hint mb-2">Warmup activity</p>
                  <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                    <Activity label="Sent today" value={act.sentToday} sub={`${act.sent7d} in 7d`} color="var(--color-brand)" />
                    <Activity label="Received today" value={act.receivedToday} sub={`${act.received7d} in 7d`} color="var(--color-ink)" />
                    <Activity label="Replied today" value={act.repliedToday} sub={`${act.replied7d} in 7d`} color="var(--color-ok)" />
                    <Activity label="In spam (7d)" value={act.inSpam7d} color="var(--color-danger)" />
                    <Activity label="Rescued (7d)" value={act.rescued7d} color="var(--color-warn)" />
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      Warmup settings
                    </h3>
                    <WarmupControls mailboxId={mailbox.id} initial={warmupState} />
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      Health
                    </h3>

                    {!latest ? (
                      <p className="hint">
                        No health data yet — run a check to populate this.
                      </p>
                    ) : (
                      <>
                        {trendInfo && (
                          <p
                            className={`text-xs ${
                              trendInfo.severity === "alert"
                                ? "text-[var(--color-danger)]"
                                : trendInfo.severity === "watch"
                                  ? "text-[var(--color-warn)]"
                                  : "text-[var(--color-muted)]"
                            }`}
                          >
                            {trendInfo.message}
                          </p>
                        )}

                        <dl className="grid grid-cols-2 gap-2 text-xs">
                          <Metric label="Sent (7d)" value={String(latest.sent_7d)} />
                          <Metric label="Bounce rate" value={pct(latest.bounce_rate)} />
                          <Metric
                            label="Complaint rate"
                            value={pct(latest.complaint_rate)}
                          />
                          <Metric
                            label="Warmup in spam"
                            value={pct(latest.warmup_spam_rate)}
                          />
                        </dl>

                        <div className="flex flex-wrap gap-2">
                          <AuthBadge label="SPF" ok={latest.spf_ok} />
                          <AuthBadge label="DKIM" ok={latest.dkim_ok} />
                          <AuthBadge label="DMARC" ok={latest.dmarc_ok} />
                          {latest.blacklists.length > 0 && (
                            <span className="badge bg-red-50 text-[var(--color-danger)]">
                              Blacklisted: {latest.blacklists.join(", ")}
                            </span>
                          )}
                        </div>

                        {trend.length > 1 && (
                          <div>
                            <p className="hint mb-1">Score, last {trend.length} check(s)</p>
                            <div className="flex h-10 items-end gap-1">
                              {trend.map((row) => (
                                <div
                                  key={row.id}
                                  title={`${row.date}: ${row.reputation_score}`}
                                  className={`w-3 rounded-sm ${
                                    row.reputation_score >= 80
                                      ? "bg-[var(--color-ok)]"
                                      : row.reputation_score >= 60
                                        ? "bg-[var(--color-warn)]"
                                        : "bg-[var(--color-danger)]"
                                  }`}
                                  style={{
                                    height: `${Math.max(8, row.reputation_score)}%`,
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                        )}

                        {latest.issues.length > 0 && (
                          <ul className="hint list-inside list-disc space-y-1">
                            {latest.issues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Glance({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <p className="hint">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function Activity({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number;
  sub?: string;
  color: string;
}) {
  return (
    <div>
      <p className="text-lg font-semibold tabular-nums" style={{ color }}>
        {value.toLocaleString()}
      </p>
      <p className="text-[11px] leading-tight text-[var(--color-muted)]">{label}</p>
      {sub && <p className="text-[10px] text-[var(--color-muted)]">{sub}</p>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function AuthBadge({ label, ok }: { label: string; ok: boolean | null }) {
  if (ok === null) {
    return <span className="badge bg-gray-100 text-gray-600">{label} ?</span>;
  }
  return (
    <span
      className={`badge ${
        ok ? "bg-green-50 text-[var(--color-ok)]" : "bg-amber-50 text-[var(--color-warn)]"
      }`}
    >
      {label} {ok ? "✓" : "missing"}
    </span>
  );
}
