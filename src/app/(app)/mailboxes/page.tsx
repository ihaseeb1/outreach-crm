import Link from "next/link";

import { MailboxActions } from "@/components/mailbox-actions";
import { MailboxConnectForm } from "@/components/mailbox-connect-form";
import { MailboxPacing } from "@/components/mailbox-pacing";
import { MailboxSignature } from "@/components/mailbox-signature";
import {
  MailboxVolume,
  VolumeWindowProvider,
  VolumeWindowToggle,
} from "@/components/mailbox-volume";
import { RunJobButton } from "@/components/run-job-button";
import { env } from "@/lib/env";
import { isOAuthConfigured } from "@/mail/providers/oauth";
import { parseSocialKeys } from "@/mail/signature";
import {
  MAX_VOLUME_WINDOW,
  summariseVolume,
  type SentRow,
} from "@/mailboxes/volume";
import { sendingAllowance } from "@/warmup/plan";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Mailbox } from "@/types/db";

export const dynamic = "force-dynamic";

const HEALTH_STYLES: Record<string, string> = {
  healthy: "bg-green-50 text-[var(--color-ok)]",
  warning: "bg-amber-50 text-[var(--color-warn)]",
  paused: "bg-red-50 text-[var(--color-danger)]",
};

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const oauthError =
    typeof params.oauth_error === "string" ? params.oauth_error : null;
  const connected = typeof params.connected === "string" ? params.connected : null;
  const supabase = await createSupabaseServerClient();

  // encrypted_credentials is revoked from the authenticated role, so it cannot
  // be selected here even by accident.
  const { data } = await supabase
    .from("mailboxes")
    .select(
      "id, email, from_name, provider, auth_type, daily_limit, sent_today, sent_today_date, min_gap_seconds, max_gap_seconds, is_active, health_status, paused_reason, last_error, last_polled_at, last_send_at, created_at, signature, meta",
    )
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: true });

  const mailboxes = (data ?? []) as Mailbox[];
  const today = new Date().toISOString().slice(0, 10);

  const { data: warmupRows } = await supabase
    .from("warmup_settings")
    .select("mailbox_id, enabled, current_daily_volume, target_daily_volume")
    .eq("workspace_id", session.workspace.id);

  // Sent volume. Read once for the whole workspace and bucketed in memory —
  // 7 / 14 / 30 counts for every mailbox would otherwise be dozens of queries.
  const volumeSince = new Date(
    Date.now() - MAX_VOLUME_WINDOW * 86_400_000,
  ).toISOString();

  const { data: sentRows } = await supabase
    .from("messages")
    .select("mailbox_id, sent_at, meta")
    .eq("workspace_id", session.workspace.id)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .gte("sent_at", volumeSince)
    .limit(20_000);

  const volumeByMailbox = summariseVolume((sentRows ?? []) as SentRow[]);

  const warmupByMailbox = new Map(
    ((warmupRows ?? []) as {
      mailbox_id: string;
      enabled: boolean;
      current_daily_volume: number;
      target_daily_volume: number;
    }[]).map((row) => [row.mailbox_id, row]),
  );

  // Checked here rather than on click, so an unconfigured provider shows as
  // unavailable instead of throwing a raw JSON error at the user.
  const googleReady = isOAuthConfigured("google");
  const microsoftReady = isOAuthConfigured("microsoft");
  const appUrl = env.appUrl();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mailboxes</h1>
          <p className="hint mt-1">
            Connect as many as you like — campaigns rotate across every active
            mailbox, and warmup pairs them with each other.
          </p>
        </div>
        <MailboxConnectForm />
      </div>

      {connected && (
        <p className="card card-pad text-sm text-[var(--color-ok)]">
          Connected {connected} over OAuth.
        </p>
      )}
      {oauthError && (
        <p className="card card-pad text-sm text-[var(--color-danger)]">
          {oauthError}
        </p>
      )}

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Connect with OAuth</h2>
        <p className="hint">
          Optional. An app password (the form above) works just as well for Gmail
          and most providers. OAuth is only worth setting up for Microsoft tenants
          that have disabled basic auth, or if you would rather not handle app
          passwords.
        </p>

        <div className="flex flex-wrap gap-2">
          {googleReady ? (
            <a className="btn-secondary" href="/api/oauth/google/start">
              Connect Gmail
            </a>
          ) : (
            <span className="btn-secondary cursor-not-allowed opacity-50">
              Connect Gmail — not configured
            </span>
          )}
          {microsoftReady ? (
            <a className="btn-secondary" href="/api/oauth/microsoft/start">
              Connect Microsoft 365
            </a>
          ) : (
            <span className="btn-secondary cursor-not-allowed opacity-50">
              Connect Microsoft 365 — not configured
            </span>
          )}
        </div>

        {(!googleReady || !microsoftReady) && (
          <details className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
            <summary className="cursor-pointer font-medium text-[var(--color-ink)]">
              How to switch OAuth on
            </summary>
            <div className="mt-2 space-y-2">
              {!googleReady && (
                <div>
                  <p className="font-medium text-[var(--color-ink)]">Gmail</p>
                  <ol className="ml-4 list-decimal space-y-0.5">
                    <li>
                      Google Cloud Console → APIs &amp; Services → Credentials →
                      Create credentials → OAuth client ID → Web application.
                    </li>
                    <li>
                      Authorised redirect URI:{" "}
                      <code>{appUrl}/api/oauth/google/callback</code>
                    </li>
                    <li>
                      Enable the Gmail API, and add your own address as a test user
                      while the consent screen is unpublished.
                    </li>
                    <li>
                      Put the client id and secret in Vercel as{" "}
                      <code>GOOGLE_OAUTH_CLIENT_ID</code> and{" "}
                      <code>GOOGLE_OAUTH_CLIENT_SECRET</code>, then redeploy.
                    </li>
                  </ol>
                </div>
              )}
              {!microsoftReady && (
                <div>
                  <p className="font-medium text-[var(--color-ink)]">Microsoft 365</p>
                  <ol className="ml-4 list-decimal space-y-0.5">
                    <li>Azure Portal → App registrations → New registration.</li>
                    <li>
                      Redirect URI (Web):{" "}
                      <code>{appUrl}/api/oauth/microsoft/callback</code>
                    </li>
                    <li>
                      Delegated permissions: SMTP.Send, IMAP.AccessAsUser.All,
                      offline_access, User.Read.
                    </li>
                    <li>
                      Set <code>MICROSOFT_OAUTH_CLIENT_ID</code>,{" "}
                      <code>MICROSOFT_OAUTH_CLIENT_SECRET</code> and optionally{" "}
                      <code>MICROSOFT_TENANT_ID</code>, then redeploy.
                    </li>
                  </ol>
                </div>
              )}
            </div>
          </details>
        )}
      </div>

      {!session.workspace.sending_postal_address && (
        <p className="card card-pad text-sm text-[var(--color-warn)]">
          No sending postal address is set, so campaign sends are blocked.{" "}
          <Link className="text-[var(--color-brand)] hover:underline" href="/settings">
            Add one in Settings
          </Link>
          .
        </p>
      )}

      {mailboxes.length === 0 ? (
        <p className="card card-pad text-sm text-[var(--color-muted)]">
          No mailboxes connected yet. For Gmail: turn on 2-Step Verification,
          create an App Password, and paste it above.
        </p>
      ) : (
        <VolumeWindowProvider>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="hint">
              Sent volume for today, or the last 7, 14 or 30 days — the same
              window for every mailbox, so they can be compared. Totals include
              warmup, which spends the daily limit rather than adding to it, so
              today&rsquo;s figure says how much of each allowance went on
              warmup and how much on real outreach.
            </p>
            <VolumeWindowToggle />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {mailboxes.map((mailbox) => {
            const sentToday =
              mailbox.sent_today_date === today ? mailbox.sent_today : 0;
            const usage = Math.min(
              100,
              Math.round((sentToday / Math.max(1, mailbox.daily_limit)) * 100),
            );

            return (
              <div key={mailbox.id} className="card card-pad space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{mailbox.email}</p>
                    <p className="hint truncate">
                      {mailbox.from_name ?? "No from name"} · {mailbox.provider}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`badge ${HEALTH_STYLES[mailbox.health_status] ?? ""}`}>
                      {mailbox.health_status}
                    </span>
                    {!mailbox.is_active && (
                      <span className="badge bg-gray-100 text-gray-700">paused</span>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
                    <span>Sent today</span>
                    <span>
                      {sentToday} / {mailbox.daily_limit}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-canvas)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-brand)]"
                      style={{ width: `${usage}%` }}
                    />
                  </div>
                </div>

                <MailboxVolume volume={volumeByMailbox[mailbox.id]} />

                <dl className="grid grid-cols-2 gap-2 text-xs text-[var(--color-muted)]">
                  <div>
                    <dt>Last send</dt>
                    <dd className="text-[var(--color-ink)]">
                      {mailbox.last_send_at
                        ? new Date(mailbox.last_send_at).toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Last inbox poll</dt>
                    <dd className="text-[var(--color-ink)]">
                      {mailbox.last_polled_at
                        ? new Date(mailbox.last_polled_at).toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                </dl>

                {mailbox.last_error && (
                  <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">
                    {mailbox.last_error}
                  </p>
                )}

                {(() => {
                  const warmup = warmupByMailbox.get(mailbox.id);
                  if (!warmup?.enabled) {
                    return (
                      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-[var(--color-warn)]">
                        Warmup is off for this mailbox, so campaign sending is
                        capped only by the daily limit below. Turn it on in{" "}
                        <Link className="underline" href="/deliverability">
                          Deliverability
                        </Link>
                        .
                      </p>
                    );
                  }
                  const allowance = sendingAllowance(mailbox.daily_limit, {
                    enabled: warmup.enabled,
                    currentDailyVolume: warmup.current_daily_volume,
                    targetDailyVolume: warmup.target_daily_volume,
                  });
                  const ramping =
                    warmup.current_daily_volume < warmup.target_daily_volume;
                  return (
                    <p className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
                      Warming up: <strong>{warmup.current_daily_volume}</strong> of{" "}
                      <strong>{warmup.target_daily_volume}</strong> a day.
                      {ramping ? (
                        <>
                          {" "}
                          Campaign sending is held to{" "}
                          <strong>{allowance}</strong> a day until the ramp
                          catches up, so a cold inbox is never pushed at full
                          volume.
                        </>
                      ) : (
                        <> Fully warmed — the daily limit below now applies.</>
                      )}
                    </p>
                  );
                })()}

                <MailboxPacing
                  id={mailbox.id}
                  dailyLimit={mailbox.daily_limit}
                  minGapSeconds={mailbox.min_gap_seconds}
                  maxGapSeconds={mailbox.max_gap_seconds}
                />

                <MailboxSignature
                  id={mailbox.id}
                  email={mailbox.email}
                  signature={mailbox.signature}
                  socials={parseSocialKeys(mailbox.meta)}
                  postalAddress={session.workspace.sending_postal_address}
                />

                <MailboxActions
                  id={mailbox.id}
                  email={mailbox.email}
                  isActive={mailbox.is_active}
                />
              </div>
            );
          })}
          </div>
        </VolumeWindowProvider>
      )}

      {mailboxes.length > 0 && (
        <div className="card card-pad space-y-3">
          <h2 className="text-sm font-semibold">Inbox polling</h2>
          <p className="hint">
            Replies are fetched over IMAP on every cron tick. Warmup mail, bounce
            notifications, autoresponders, and your own personal correspondence are
            filtered out — only genuine replies from people you emailed reach the
            unified inbox.
          </p>
          {/* No limit, deliberately. This used to be capped at five, which is
              where "Checked 5 of 5" came from on a workspace with seven
              mailboxes: the button was reporting its own cap back as the total.
              Every connected mailbox is polled now, paused ones included, and
              the button keeps asking until the queue is empty. */}
          <RunJobButton job="inbound" label="Poll mailboxes now" />
        </div>
      )}
    </div>
  );
}
