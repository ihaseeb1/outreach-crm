"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PROVIDER_PRESETS, type ProviderKey } from "@/mail/providers/presets";

/**
 * Connects a mailbox. Credentials are posted once, verified against the real
 * SMTP and IMAP servers, then stored encrypted — they are never read back.
 */
export function MailboxConnectForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderKey>("gmail");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [dailyLimit, setDailyLimit] = useState(50);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = PROVIDER_PRESETS[provider];

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/mailboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          email,
          password,
          from_name: fromName || undefined,
          daily_limit: dailyLimit,
          ...(provider === "smtp"
            ? {
                smtp_host: smtpHost,
                smtp_port: smtpPort,
                smtp_secure: smtpPort === 465,
                imap_host: imapHost,
                imap_port: imapPort,
                imap_secure: true,
              }
            : {}),
        }),
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not connect.");

      setEmail("");
      setPassword("");
      setFromName("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)} type="button">
        Connect a mailbox
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Connect a mailbox</h2>
        <button
          className="hint hover:underline"
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="provider">
            Provider
          </label>
          <select
            id="provider"
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderKey)}
          >
            {Object.entries(PROVIDER_PRESETS).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="mailbox-email">
            Email address
          </label>
          <input
            id="mailbox-email"
            className="input"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="mailbox-password">
            App password
          </label>
          <input
            id="mailbox-password"
            className="input"
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="from-name">
            From name
          </label>
          <input
            id="from-name"
            className="input"
            placeholder="Your Name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="daily-limit">
            Daily send limit
          </label>
          <input
            id="daily-limit"
            className="input"
            type="number"
            min={1}
            max={2000}
            value={dailyLimit}
            onChange={(e) => setDailyLimit(Number(e.target.value))}
          />
          <p className="hint mt-1">
            Gmail free caps at 500/day, Workspace at 2,000. Start low — 30–50 —
            and let warmup raise it.
          </p>
        </div>
      </div>

      {provider === "smtp" && (
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="smtp-host">
              SMTP host
            </label>
            <input
              id="smtp-host"
              className="input"
              required
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="smtp-port">
              SMTP port
            </label>
            <input
              id="smtp-port"
              className="input"
              type="number"
              value={smtpPort}
              onChange={(e) => setSmtpPort(Number(e.target.value))}
            />
          </div>
          <div />
          <div className="sm:col-span-2">
            <label className="label" htmlFor="imap-host">
              IMAP host
            </label>
            <input
              id="imap-host"
              className="input"
              required
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="imap-port">
              IMAP port
            </label>
            <input
              id="imap-port"
              className="input"
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(Number(e.target.value))}
            />
          </div>
        </div>
      )}

      <p className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
        {preset.help}
      </p>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <button className="btn-primary" type="submit" disabled={busy}>
        {busy ? "Verifying SMTP and IMAP…" : "Verify and connect"}
      </button>
      <p className="hint">
        Credentials are checked against the real servers before anything is
        saved, then encrypted with AES-256-GCM at rest.
      </p>
    </form>
  );
}
