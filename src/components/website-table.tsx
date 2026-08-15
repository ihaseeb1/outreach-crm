"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { Website } from "@/types/db";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  scraping: "bg-blue-50 text-[var(--color-brand)]",
  done: "bg-green-50 text-[var(--color-ok)]",
  failed: "bg-red-50 text-[var(--color-danger)]",
  skipped_robots: "bg-amber-50 text-[var(--color-warn)]",
};

/**
 * The websites list, with selection so a batch of problem sites can be
 * requeued, deleted, or opened in tabs for a manual look.
 *
 * Filtering happens on the server (see the form on the prospecting page) so it
 * covers every row, not just the page that happens to be loaded.
 */
export function WebsiteTable({ websites }: { websites: Website[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const allSelected = websites.length > 0 && selected.size === websites.length;
  const selectedSites = useMemo(
    () => websites.filter((site) => selected.has(site.id)),
    [websites, selected],
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(websites.map((s) => s.id)));
  }

  async function call(method: "PATCH" | "DELETE", body: unknown, verb: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/websites", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Request failed.");
      setMessage(`${verb} ${payload.requeued ?? payload.deleted} website(s).`);
      setSelected(new Set());
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Popup blockers stop a burst of window.open calls unless they are all in the
   * same user gesture, which they are here. Ten is the practical ceiling before
   * Chrome starts dropping them anyway.
   */
  function openSelected() {
    const batch = selectedSites.slice(0, 10);
    for (const site of batch) {
      window.open(site.url, "_blank", "noopener,noreferrer");
    }
    if (selectedSites.length > batch.length) {
      setMessage(
        `Opened the first ${batch.length}. Browsers block more than that at once — select fewer and repeat.`,
      );
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={openSelected}
        >
          Open {selected.size || ""} in tabs
        </button>
        <button
          className="btn-secondary"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void call("PATCH", { ids: [...selected] }, "Requeued")}
        >
          Retry selected
        </button>
        <button
          className="btn-secondary"
          type="button"
          disabled={busy}
          onClick={() => void call("PATCH", { status: "failed" }, "Requeued")}
        >
          Retry all failed
        </button>
        <button
          className="btn-secondary text-[var(--color-danger)]"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => {
            if (!confirm(`Delete ${selected.size} website(s) from the list?`)) return;
            void call("DELETE", { ids: [...selected] }, "Deleted");
          }}
        >
          Delete selected
        </button>
        {message && <span className="hint">{message}</span>}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all websites"
                />
              </th>
              <th>Domain</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Emails</th>
              <th>Error</th>
              <th>Scraped</th>
            </tr>
          </thead>
          <tbody>
            {websites.map((site) => (
              <tr key={site.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(site.id)}
                    onChange={() => toggle(site.id)}
                    aria-label={`Select ${site.domain}`}
                  />
                </td>
                <td>
                  <a
                    className="text-[var(--color-brand)] hover:underline"
                    href={site.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {site.domain}
                  </a>
                </td>
                <td>
                  <span className={`badge ${STATUS_STYLES[site.status] ?? ""}`}>
                    {site.status}
                  </span>
                </td>
                <td>
                  {site.http_status ? (
                    <span
                      className={`badge ${
                        site.http_status >= 400
                          ? "bg-red-50 text-[var(--color-danger)]"
                          : "bg-green-50 text-[var(--color-ok)]"
                      }`}
                    >
                      {site.http_status}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{site.emails_found}</td>
                <td className="max-w-xs truncate" title={site.error ?? ""}>
                  {site.error ?? "—"}
                </td>
                <td>
                  {site.scraped_at
                    ? new Date(site.scraped_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
