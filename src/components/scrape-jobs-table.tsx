"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { fmtDateTime } from "@/lib/datetime";

export interface ScrapeJobRow {
  id: string;
  status: string;
  total_count: number;
  processed_count: number;
  found_count: number;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  running: "bg-blue-50 text-[var(--color-brand)]",
  completed: "bg-green-50 text-[var(--color-ok)]",
  failed: "bg-red-50 text-[var(--color-danger)]",
};

export function ScrapeJobsTable({
  jobs,
  canDelete,
}: {
  jobs: ScrapeJobRow[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removeContacts, setRemoveContacts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id)),
    );
  }

  async function remove(ids: string[]) {
    if (ids.length === 0) return;
    const contactsLine = removeContacts
      ? " Contacts that came only from these jobs and were never contacted will also be removed."
      : " Contacts already imported are kept.";
    if (
      !confirm(
        `Delete ${ids.length} scrape job(s) and their raw results?${contactsLine}`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/scrape-jobs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, removeContacts }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Could not delete.");
        return;
      }
      setNote(
        `Deleted ${json.jobs} job(s), ${json.websitesRemoved} website(s)` +
          (json.contactsRemoved ? `, ${json.contactsRemoved} contact(s)` : "") +
          ".",
      );
      setSelected(new Set());
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {canDelete && (
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-line)] px-5 py-3">
          <button
            className="btn-secondary px-2.5 py-1.5 text-xs"
            disabled={busy || selected.size === 0}
            onClick={() => remove([...selected])}
          >
            Delete selected ({selected.size})
          </button>
          <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={removeContacts}
              onChange={(e) => setRemoveContacts(e.target.checked)}
            />
            Also remove never-contacted contacts from these jobs
          </label>
          {note && <span className="hint text-[var(--color-ok)]">{note}</span>}
          {error && <span className="hint text-[var(--color-danger)]">{error}</span>}
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {canDelete && (
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === jobs.length && jobs.length > 0}
                    onChange={toggleAll}
                  />
                </th>
              )}
              <th>Created</th>
              <th>Status</th>
              <th>Processed</th>
              <th>Emails found</th>
              {canDelete && <th></th>}
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                {canDelete && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label="Select job"
                      checked={selected.has(job.id)}
                      onChange={() => toggle(job.id)}
                    />
                  </td>
                )}
                <td>{fmtDateTime(job.created_at)}</td>
                <td>
                  <span className={`badge ${STATUS_STYLES[job.status] ?? ""}`}>
                    {job.status}
                  </span>
                </td>
                <td>
                  {job.processed_count} / {job.total_count}
                </td>
                <td>{job.found_count}</td>
                {canDelete && (
                  <td>
                    <button
                      className="btn-secondary px-2 py-1 text-xs text-[var(--color-danger)]"
                      disabled={busy}
                      onClick={() => remove([job.id])}
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
