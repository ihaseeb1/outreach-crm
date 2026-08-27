"use client";

import { useState } from "react";

/** Mirrors VerificationResult from the engine (snake-free, camelCase JSON). */
interface VerificationResult {
  email: string;
  username: string;
  domain: string;
  status: string;
  overallScore: number;
  isSafeToSend: boolean;
  isValidSyntax: boolean;
  isDisposable: boolean;
  isRoleAccount: boolean;
  isFreeEmail: boolean;
  mxAcceptsMail: boolean;
  mxRecords: string[];
  canConnectSmtp: boolean | null;
  isCatchAll: boolean | null;
  hasInboxFull: boolean | null;
  isDisabled: boolean | null;
  isDeliverable: boolean | null;
  isSpamtrap: boolean;
  didYouMean: string | null;
  mode: string;
  detail: string;
}

const STATUS_STYLES: Record<string, string> = {
  safe: "bg-green-50 text-[var(--color-ok)]",
  valid: "bg-green-50 text-[var(--color-ok)]",
  role_account: "bg-blue-50 text-[var(--color-brand)]",
  catch_all: "bg-amber-50 text-[var(--color-warn)]",
  unknown: "bg-gray-100 text-gray-600",
  disposable: "bg-red-50 text-[var(--color-danger)]",
  invalid: "bg-red-50 text-[var(--color-danger)]",
  invalid_syntax: "bg-red-50 text-[var(--color-danger)]",
  no_mx: "bg-red-50 text-[var(--color-danger)]",
  spamtrap: "bg-red-50 text-[var(--color-danger)]",
  disabled: "bg-red-50 text-[var(--color-danger)]",
  inbox_full: "bg-amber-50 text-[var(--color-warn)]",
};

function label(status: string): string {
  return status.replace(/_/g, " ");
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600"}`}>
      {label(status)}
    </span>
  );
}

function Check({ label: text, value }: { label: string; value: boolean | null }) {
  const mark = value === null ? "—" : value ? "yes" : "no";
  const tone =
    value === null
      ? "text-[var(--color-muted)]"
      : value
        ? "text-[var(--color-ok)]"
        : "text-[var(--color-danger)]";
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] py-1 text-xs last:border-0">
      <span className="text-[var(--color-muted)]">{text}</span>
      <span className={`font-medium ${tone}`}>{mark}</span>
    </div>
  );
}

function ResultCard({ result }: { result: VerificationResult }) {
  return (
    <div className="card card-pad space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{result.email}</p>
          <p className="hint">{result.detail}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{result.overallScore}/100</span>
          <StatusBadge status={result.status} />
        </div>
      </div>

      {result.didYouMean && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-[var(--color-warn)]">
          Did you mean <strong>{result.username}@{result.didYouMean}</strong>?
        </p>
      )}

      <div className="grid gap-x-6 gap-y-0 sm:grid-cols-2">
        <Check label="Valid syntax" value={result.isValidSyntax} />
        <Check label="MX accepts mail" value={result.mxAcceptsMail} />
        <Check label="Role account" value={result.isRoleAccount} />
        <Check label="Free provider" value={result.isFreeEmail} />
        <Check label="Disposable" value={result.isDisposable} />
        <Check label="Spam trap" value={result.isSpamtrap} />
        <Check label="SMTP connect (power)" value={result.canConnectSmtp} />
        <Check label="Catch-all (power)" value={result.isCatchAll} />
        <Check label="Inbox full (power)" value={result.hasInboxFull} />
        <Check label="Disabled (power)" value={result.isDisabled} />
        <Check label="Safe to send" value={result.isSafeToSend} />
        <Check label="Deliverable" value={result.isDeliverable} />
      </div>

      {result.mxRecords.length > 0 && (
        <p className="hint break-words">
          MX: {result.mxRecords.join(", ")}
        </p>
      )}
      {result.mode === "power" && result.canConnectSmtp === false && (
        <p className="hint text-[var(--color-warn)]">
          The SMTP mailbox check could not run here (outbound port 25 is blocked
          on the server). Run the verify worker on a box with port 25 open for the
          deep check — this result covers everything else.
        </p>
      )}
    </div>
  );
}

export function EmailVerifier() {
  const [tab, setTab] = useState<"single" | "bulk">("single");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[
          { key: "single" as const, label: "Verify one" },
          { key: "bulk" as const, label: "Verify a list" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`badge ${
              tab === t.key
                ? "bg-blue-50 text-[var(--color-brand)]"
                : "bg-[var(--color-canvas)] text-[var(--color-muted)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "single" ? <SingleVerify /> : <BulkVerify />}
    </div>
  );
}

function SingleVerify() {
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"quick" | "power">("quick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);

  async function run() {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/verify/single", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), mode }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not verify.");
      setResult(payload.result as VerificationResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card card-pad space-y-3">
        <div className="flex flex-wrap gap-2">
          <input
            className="input flex-1"
            type="text"
            placeholder="name@example.com"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <select
            className="input w-32"
            value={mode}
            disabled={busy}
            onChange={(e) => setMode(e.target.value as "quick" | "power")}
          >
            <option value="quick">Quick</option>
            <option value="power">Power</option>
          </select>
          <button className="btn-primary" type="button" disabled={busy} onClick={() => void run()}>
            {busy ? "Checking…" : "Verify"}
          </button>
        </div>
        <p className="hint">
          Quick checks syntax, domain, MX, disposable and role. Power also opens a
          real SMTP conversation to confirm the mailbox exists and detect
          catch-all — run on a box with port 25 open.
        </p>
        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </div>

      {result && <ResultCard result={result} />}
    </div>
  );
}

interface BulkResponse {
  submitted: number;
  verified: number;
  truncated: number;
  summary: Record<string, number>;
  results: VerificationResult[];
}

const SENDABLE = new Set(["safe", "valid", "role_account", "catch_all"]);

function BulkVerify() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BulkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function run() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch("/api/verify/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not verify.");
      setData(payload as BulkResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const cleanList = data
    ? data.results.filter((r) => SENDABLE.has(r.status)).map((r) => r.email)
    : [];

  async function copyClean() {
    try {
      await navigator.clipboard.writeText(cleanList.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card card-pad space-y-3">
        <textarea
          className="input min-h-[140px] font-mono text-sm"
          placeholder={"Paste addresses — one per line, or any messy list.\nname@example.com\ninfo@site.org, sales@shop.com"}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" type="button" disabled={busy} onClick={() => void run()}>
            {busy ? "Verifying…" : "Verify list"}
          </button>
          <span className="hint">Quick mode, up to 300 at a time.</span>
        </div>
        {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
      </div>

      {data && (
        <div className="space-y-3">
          <div className="card card-pad space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <strong>{data.verified}</strong> verified
                {data.truncated > 0 && ` · ${data.truncated} not shown (over the 300 cap)`}
              </p>
              <button
                className="btn-secondary px-2.5 py-1.5 text-xs"
                type="button"
                disabled={cleanList.length === 0}
                onClick={() => void copyClean()}
              >
                {copied ? "Copied!" : `Copy ${cleanList.length} sendable`}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.summary)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <span key={status} className={`badge ${STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600"}`}>
                    {label(status)}: {count}
                  </span>
                ))}
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-xs text-[var(--color-muted)]">
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={r.email} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.email}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                    <td className="px-3 py-2">{r.overallScore}</td>
                    <td className="px-3 py-2 text-xs text-[var(--color-muted)]">
                      {r.didYouMean ? `Did you mean …@${r.didYouMean}?` : r.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
