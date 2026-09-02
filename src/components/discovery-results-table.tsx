"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { downloadCsv } from "@/lib/csv";
import { StageSelect } from "@/components/stage-select-inline";
import type { DiscoveredSite } from "@/types/db";

/**
 * The discovered-sites table for one run: sortable by opportunity score, with a
 * score-threshold filter, multi-select, and bulk "Send to Prospecting" (which
 * pushes the selected sites into the existing prospecting/scrape queue).
 */
export interface DiscoveryResultRow {
  id: string;
  root_domain: string;
  guest_post_url: string | null;
  matched_footprint: string | null;
  best_position: number | null;
  opportunity_score: number | null;
  status: DiscoveredSite["status"];
  pushed_website_id: string | null;
}

type SortKey = "opportunity_score" | "best_position" | "root_domain";

export function DiscoveryResultsTable({
  rows,
  runId,
}: {
  rows: DiscoveryResultRow[];
  runId: string;
}) {
  const router = useRouter();
  const [threshold, setThreshold] = useState(0);
  const [sort, setSort] = useState<SortKey>("opportunity_score");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => (r.opportunity_score ?? 0) >= threshold);
    return [...list].sort((a, b) => {
      if (sort === "root_domain") return a.root_domain.localeCompare(b.root_domain);
      if (sort === "best_position") {
        return (a.best_position ?? 999) - (b.best_position ?? 999);
      }
      return (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0);
    });
  }, [rows, threshold, sort]);

  const selectableIds = filtered.filter((r) => !r.pushed_website_id).map((r) => r.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  async function act(url: string, describe: (n: number) => string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, ids: [...selected] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setMessage(describe(payload.pushed ?? payload.marked ?? 0));
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const push = () =>
    act("/api/discovery/push", (n) => `Sent ${n} site(s) to Prospecting.`);
  const findAuthors = () =>
    act("/api/discovery/find-authors", (n) => `Queued ${n} site(s) for author crawl.`);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          Min opportunity
          <input
            type="range"
            min={0}
            max={100}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <span className="w-8 tabular-nums">{threshold}</span>
        </label>

        <label className="flex items-center gap-2 text-sm">
          Sort
          <select
            className="input"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="opportunity_score">Opportunity (high→low)</option>
            <option value="best_position">SERP position (best first)</option>
            <option value="root_domain">Domain (A→Z)</option>
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn-ghost"
            type="button"
            onClick={() =>
              downloadCsv(
                "discovered-sites",
                ["Domain", "Opportunity", "Footprint", "Position", "Stage", "URL", "In prospecting"],
                filtered.map((r) => [
                  r.root_domain,
                  r.opportunity_score,
                  r.matched_footprint,
                  r.best_position,
                  r.status,
                  r.guest_post_url,
                  r.pushed_website_id ? "yes" : "no",
                ]),
              )
            }
          >
            Export CSV
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={busy || selected.size === 0}
            onClick={findAuthors}
            title="Crawl these publishers for recent guest authors"
          >
            Find authors{selected.size ? ` (${selected.size})` : ""}
          </button>
          <button
            className="btn-primary"
            type="button"
            disabled={busy || selected.size === 0}
            onClick={push}
          >
            {busy ? "Working…" : `Send ${selected.size || ""} to Prospecting`}
          </button>
        </div>
      </div>

      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              <th>Domain</th>
              <th>Score</th>
              <th>Footprint</th>
              <th>Pos</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="hint py-6 text-center">
                  No sites at this threshold yet.
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.pushed_website_id ? (
                    <span className="hint" title="Already in Prospecting">
                      ✓
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  )}
                </td>
                <td>
                  {row.guest_post_url ? (
                    <a
                      href={row.guest_post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[var(--color-brand)]"
                    >
                      {row.root_domain}
                    </a>
                  ) : (
                    <span className="font-medium">{row.root_domain}</span>
                  )}
                </td>
                <td className="tabular-nums">{row.opportunity_score ?? "—"}</td>
                <td className="hint max-w-[24rem] truncate" title={row.matched_footprint ?? ""}>
                  {row.matched_footprint ?? "—"}
                </td>
                <td className="tabular-nums">{row.best_position ?? "—"}</td>
                <td>
                  <div className="flex items-center gap-1">
                    <StageSelect entity="site" id={row.id} value={row.status} />
                    {row.pushed_website_id && (
                      <span className="hint" title="In prospecting">↗</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
