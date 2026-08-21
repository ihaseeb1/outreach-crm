"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SuppressionForm() {
  const router = useRouter();
  const [emails, setEmails] = useState("");
  const [reason, setReason] = useState("manual");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/suppressions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails, reason }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setMessage(`Suppressed ${payload.added} address(es).`);
      setEmails("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-3">
      <div>
        <label className="label" htmlFor="emails">
          Add addresses
        </label>
        <textarea
          id="emails"
          className="input min-h-24 font-mono text-xs"
          placeholder={"someone@example.com\nanother@example.org"}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
        />
        <p className="hint mt-1">
          One per line. Suppressed addresses are never emailed again by any
          campaign or by warmup.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="reason">
            Reason
          </label>
          <select
            id="reason"
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="manual">Manual</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="opted_out">Opted out</option>
            <option value="complaint">Complaint</option>
            <option value="hard_bounce">Hard bounce</option>
          </select>
        </div>
        <button className="btn-primary" type="submit" disabled={busy || !emails.trim()}>
          {busy ? "Adding…" : "Add to suppression list"}
        </button>
      </div>

      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}

// The per-row remove button moved into `suppression-table.tsx`, which owns
// selection as well and so can delete one row or fifty through the same path.
