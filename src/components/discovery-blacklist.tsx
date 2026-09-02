"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SuppressionListEntry } from "@/types/db";

/**
 * The discovery blacklist manager: competitor / owned / manually-blocked
 * domains and emails that discovery and publisher results are filtered against.
 * Separate from the outbound suppression list — nothing here affects sending.
 */
export function DiscoveryBlacklist({
  rows,
}: {
  rows: Pick<SuppressionListEntry, "id" | "value" | "kind" | "reason">[];
}) {
  const router = useRouter();
  const [values, setValues] = useState("");
  const [kind, setKind] = useState<"domain" | "email">("domain");
  const [reason, setReason] = useState("competitor");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/discovery/suppression", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values, kind, reason }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setMessage(`Blacklisted ${payload.added} ${kind}(s).`);
      setValues("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch("/api/discovery/suppression", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [id] }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card card-pad">
      <summary className="cursor-pointer font-medium">
        Discovery blacklist ({rows.length}) — competitors &amp; owned domains
      </summary>

      <form onSubmit={add} className="mt-3 space-y-3">
        <textarea
          className="input min-h-20 font-mono text-xs"
          placeholder={"competitor.com\nrival-agency.com"}
          value={values}
          onChange={(e) => setValues(e.target.value)}
        />
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "domain" | "email")}>
              <option value="domain">Domain</option>
              <option value="email">Email</option>
            </select>
          </div>
          <div>
            <label className="label">Reason</label>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="competitor">Competitor</option>
              <option value="owned">Owned</option>
              <option value="manual">Manual</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="bounced">Bounced</option>
            </select>
          </div>
          <button className="btn-secondary" type="submit" disabled={busy || !values.trim()}>
            {busy ? "Adding…" : "Add to blacklist"}
          </button>
        </div>
        {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </form>

      {rows.length > 0 && (
        <div className="table-wrap mt-3">
          <table className="table">
            <thead>
              <tr>
                <th>Value</th>
                <th>Type</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="font-mono text-xs">{row.value}</td>
                  <td>{row.kind}</td>
                  <td className="hint">{row.reason}</td>
                  <td className="text-right">
                    <button className="btn-ghost text-xs" type="button" onClick={() => remove(row.id)} disabled={busy}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
