"use client";

import { useState } from "react";

import { downloadCsv } from "@/lib/csv";
import type { DomainVerdict } from "@/lib/availability";

/**
 * Paste websites → check each against the whole workspace (deals, contacts,
 * prospecting, discovery, publishers) → see which are still available to work
 * and which are already in the pipeline, and where.
 */

const SOURCE_TONE: Record<string, string> = {
  deal: "text-[var(--color-danger)]",
  contact: "text-[var(--color-brand)]",
  publisher: "text-[var(--color-brand)]",
  discovery: "text-[var(--color-muted)]",
  website: "text-[var(--color-muted)]",
};

export function AvailabilityChecker() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    total: number;
    available: number;
    notAvailable: number;
    verdicts: DomainVerdict[];
  } | null>(null);
  const [showOnly, setShowOnly] = useState<"all" | "available" | "taken">("all");

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/availability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setResult(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const shown =
    result?.verdicts.filter((v) =>
      showOnly === "all" ? true : showOnly === "available" ? v.available : !v.available,
    ) ?? [];

  return (
    <div className="space-y-4">
      <div className="card card-pad space-y-3">
        <label className="block text-sm font-medium" htmlFor="domains">
          Paste websites (one per line, or comma-separated — URLs are fine)
        </label>
        <textarea
          id="domains"
          className="input min-h-[8rem] w-full font-mono text-sm"
          placeholder={"example.com\nhttps://www.another-site.co.uk/blog\nthird.org"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <button className="btn-primary" type="button" disabled={busy || !input.trim()} onClick={check}>
            {busy ? "Checking…" : "Check availability"}
          </button>
          {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>
      </div>

      {result && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span>
              <strong>{result.total}</strong> checked
            </span>
            <span className="text-[var(--color-ok)]">
              <strong>{result.available}</strong> available
            </span>
            <span className="text-[var(--color-muted)]">
              <strong>{result.notAvailable}</strong> already in pipeline
            </span>
            <label className="ml-auto flex items-center gap-2">
              Show
              <select
                className="input"
                value={showOnly}
                onChange={(e) => setShowOnly(e.target.value as typeof showOnly)}
              >
                <option value="all">All</option>
                <option value="available">Available only</option>
                <option value="taken">In pipeline only</option>
              </select>
            </label>
            <button
              className="btn-ghost"
              type="button"
              onClick={() =>
                downloadCsv(
                  "availability",
                  ["Domain", "Available", "Found in"],
                  result.verdicts.map((v) => [
                    v.domain,
                    v.available ? "yes" : "no",
                    v.hits.map((h) => h.detail).join("; "),
                  ]),
                )
              }
            >
              Export CSV
            </button>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Website</th>
                  <th>Status</th>
                  <th>Found in</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={3} className="hint py-6 text-center">
                      Nothing to show.
                    </td>
                  </tr>
                )}
                {shown.map((v) => (
                  <tr key={v.domain}>
                    <td className="font-medium">{v.domain}</td>
                    <td>
                      {v.available ? (
                        <span className="text-[var(--color-ok)]">Available</span>
                      ) : (
                        <span className="text-[var(--color-muted)]">In pipeline</span>
                      )}
                    </td>
                    <td>
                      {v.hits.length === 0 ? (
                        <span className="hint">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-2">
                          {v.hits.map((h, i) => (
                            <span
                              key={i}
                              className={`rounded px-1.5 py-0.5 text-xs ${SOURCE_TONE[h.source] ?? ""}`}
                              style={{ background: "var(--color-surface-2, rgba(0,0,0,0.04))" }}
                            >
                              {h.detail}
                            </span>
                          ))}
                        </span>
                      )}
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
