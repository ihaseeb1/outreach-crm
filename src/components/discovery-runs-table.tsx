"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ISO_3166 } from "@/discovery/geo";
import type { DiscoveryRun } from "@/types/db";

/**
 * The discovery runs history, with selection + delete so old runs can be
 * cleared. Deleting a run cascades to its discovered_sites (FK on delete
 * cascade), so a cleared run leaves no orphans. A run that is still `running`
 * is left in place by the API and shown non-selectable here.
 */

const STATUS_TONE: Record<string, string> = {
  pending: "text-[var(--color-muted)]",
  running: "text-[var(--color-brand)]",
  completed: "text-[var(--color-ok)]",
  failed: "text-[var(--color-danger)]",
};

function geoLabel(code: string): string {
  if (code === "WORLDWIDE") return "Worldwide";
  return ISO_3166[code] ?? code;
}

export function DiscoveryRunsTable({ runs }: { runs: DiscoveryRun[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only non-running runs can be deleted.
  const deletableIds = runs.filter((r) => r.status !== "running").map((r) => r.id);
  const allSelected =
    deletableIds.length > 0 && deletableIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteRuns(body: { ids?: string[]; all?: boolean }) {
    const what = body.all ? "all discovery history" : `${body.ids?.length ?? 0} run(s)`;
    if (!window.confirm(`Delete ${what}? The sites found in them are removed too.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/discovery/runs", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Run history</h2>
        <button
          className="btn-ghost text-[var(--color-danger)]"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => deleteRuns({ ids: [...selected] })}
        >
          {`Delete ${selected.size || ""}`.trim()}
        </button>
        <button
          className="btn-ghost text-[var(--color-danger)]"
          type="button"
          disabled={busy || deletableIds.length === 0}
          onClick={() => deleteRuns({ all: true })}
        >
          Clear all history
        </button>
      </div>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(deletableIds))
                  }
                />
              </th>
              <th>Niche</th>
              <th>Region</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Found</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="hint py-6 text-center">
                  No runs yet. Start one above.
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  {run.status === "running" ? (
                    <span className="hint" title="A running run can't be deleted">
                      –
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={selected.has(run.id)}
                      onChange={() => toggle(run.id)}
                    />
                  )}
                </td>
                <td>
                  <Link
                    href={`/discovery/${run.id}`}
                    className="font-medium text-[var(--color-brand)]"
                  >
                    {run.niche}
                  </Link>
                </td>
                <td>{geoLabel(run.geo)}</td>
                <td className={STATUS_TONE[run.status] ?? ""}>{run.status}</td>
                <td className="hint">
                  {run.processed_queries}/{run.total_queries}
                </td>
                <td>{run.found_count}</td>
                <td className="hint">{new Date(run.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
