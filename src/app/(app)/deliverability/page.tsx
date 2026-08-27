import Link from "next/link";

import { ClearAutoPauseButton } from "@/components/clear-auto-pause";
import { RunJobButton } from "@/components/run-job-button";
import { WarmupControls, type WarmupState } from "@/components/warmup-controls";
import { fmtDateTime } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Mailbox, MailboxHealth, WarmupSettings } from "@/types/db";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  healthy: "bg-green-50 text-[var(--color-ok)]",
  warning: "bg-amber-50 text-[var(--color-warn)]",
  paused: "bg-red-50 text-[var(--color-danger)]",
};

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export default async function DeliverabilityPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const [{ data: mailboxRows }, { data: warmupRows }, { data: healthRows }] =
    await Promise.all([
      supabase
        .from("mailboxes")
        .select(
          "id, email, from_name, is_active, health_status, paused_reason, daily_limit, sent_today, sent_today_date",
        )
        .eq("workspace_id", session.workspace.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("warmup_settings")
        .select("*")
        .eq("workspace_id", session.workspace.id),
      supabase
        .from("mailbox_health")
        .select("*")
        .eq("workspace_id", session.workspace.id)
        .order("date", { ascending: false })
        .limit(200),
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

  const poolSize = mailboxes.filter((mailbox) => mailbox.is_active).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Deliverability</h1>
        <p className="hint mt-1">
          Peer warmup and daily health monitoring for every connected mailbox.
        </p>
      </div>

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

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">How this works</h2>
        <ul className="hint list-inside list-disc space-y-1">
          <li>
            Your mailboxes send each other ordinary-looking mail, open it, flag it,
            and reply to a fraction of it.
          </li>
          <li>
            Anything that lands in spam is moved back to the inbox — the single
            strongest signal you can generate for free.
          </li>
          <li>
            Volume starts at 5/day and climbs by a small increment daily. It never
            spikes: providers detect artificial warmup, and a jump is the clearest
            tell there is.
          </li>
          <li>
            Warmup counts against the same daily limit as campaigns. A mailbox
            auto-paused for poor health stops <em>outreach</em> but keeps warming
            up, so it can recover — you stay in control of the warmup toggle and
            can resume sending by hand any time.
          </li>
          <li>Warmup mail never appears in your unified inbox.</li>
        </ul>
        <div className="flex flex-wrap gap-4">
          <RunJobButton job="warmup" label="Run warmup now" limit={5} />
          <RunJobButton job="health" label="Run health check now" limit={10} />
        </div>
      </div>

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
                    {latest && (
                      <span className="text-sm font-semibold">
                        {latest.reputation_score}/100
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
                      Outreach is stopped. Warmup keeps running below so the
                      mailbox can recover — you can also turn it on/off here by
                      hand. Resume sending once it looks healthy again.
                    </p>
                    <ClearAutoPauseButton mailboxId={mailbox.id} />
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      Warmup
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
