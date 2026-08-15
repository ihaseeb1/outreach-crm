import Link from "next/link";

import { MailboxActions } from "@/components/mailbox-actions";
import { MailboxConnectForm } from "@/components/mailbox-connect-form";
import { RunJobButton } from "@/components/run-job-button";
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
      "id, email, from_name, provider, auth_type, daily_limit, sent_today, sent_today_date, is_active, health_status, paused_reason, last_error, last_polled_at, last_send_at, created_at",
    )
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: true });

  const mailboxes = (data ?? []) as Mailbox[];
  const today = new Date().toISOString().slice(0, 10);

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
          No app password needed, and it keeps working on Microsoft tenants that
          have disabled basic auth. Requires the OAuth client id and secret to be
          set in the environment first.
        </p>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href="/api/oauth/google/start">
            Connect Gmail
          </a>
          <a className="btn-secondary" href="/api/oauth/microsoft/start">
            Connect Microsoft 365
          </a>
        </div>
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
        <div className="grid gap-4 lg:grid-cols-2">
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

                <MailboxActions
                  id={mailbox.id}
                  email={mailbox.email}
                  isActive={mailbox.is_active}
                />
              </div>
            );
          })}
        </div>
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
          <RunJobButton job="inbound" label="Poll mailboxes now" limit={5} />
        </div>
      )}
    </div>
  );
}
