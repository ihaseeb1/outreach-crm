"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { downloadCsv } from "@/lib/csv";
import { StageSelect } from "@/components/stage-select-inline";
import type { ActiveAuthor, AuthorEmailStatus, RelationshipStage } from "@/types/db";

/**
 * The active-authors table: guest authors found on crawled publishers, with
 * their resolved destination site, recency scores and (once enriched) contact
 * details. Filter by email status and pipeline stage; add verified contacts to
 * a campaign in bulk.
 */
export interface AuthorRow {
  id: string;
  author_name: string | null;
  source_domain: string;
  source_post_url: string;
  destination_domain: string;
  published_at: string | null;
  detection_score: number | null;
  freshness_score: number | null;
  latest_post_title: string | null;
  email: string | null;
  email_status: AuthorEmailStatus;
  phone: string | null;
  phone_region: string | null;
  status: RelationshipStage;
}

const EMAIL_TONE: Record<string, string> = {
  verified: "text-[var(--color-ok)]",
  unverified: "text-[var(--color-muted)]",
  role_account: "text-[var(--color-muted)]",
  disposable: "text-[var(--color-danger)]",
  no_mx: "text-[var(--color-danger)]",
  invalid_syntax: "text-[var(--color-danger)]",
  unknown: "text-[var(--color-muted)]",
};

export function ActiveAuthorsTable({ rows }: { rows: AuthorRow[] }) {
  const router = useRouter();
  const [emailFilter, setEmailFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return rows
      .filter((r) => (emailFilter === "all" ? true : r.email_status === emailFilter))
      .filter((r) => (stageFilter === "all" ? true : r.status === stageFilter))
      .sort((a, b) => (b.freshness_score ?? 0) - (a.freshness_score ?? 0));
  }, [rows, emailFilter, stageFilter]);

  // Only verified-email authors are eligible for a campaign; any row may be
  // selected for deletion, so select-all covers every filtered row.
  const verifiedSelectedCount = filtered.filter(
    (r) => r.email_status === "verified" && selected.has(r.id),
  ).length;
  const allIds = filtered.map((r) => r.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addToCampaign() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/publishers/campaign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setMessage(
        `Added ${payload.added} contact(s) to prospecting${
          payload.skipped ? `, ${payload.skipped} skipped` : ""
        }.`,
      );
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAuthors(body: { ids?: string[]; all?: boolean }) {
    const count = body.all ? rows.length : (body.ids?.length ?? 0);
    const what = body.all ? "all publisher history" : `${count} author(s)`;
    if (!window.confirm(`Delete ${what}? Contacts already added are kept.`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/publishers", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setMessage(`Deleted ${payload.deleted} author(s).`);
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
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          Email
          <select className="input" value={emailFilter} onChange={(e) => setEmailFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="verified">Verified</option>
            <option value="unverified">Unverified</option>
            <option value="role_account">Role account</option>
            <option value="unknown">Not enriched</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Stage
          <select className="input" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="replied">Replied</option>
            <option value="published">Published</option>
            <option value="won">Won</option>
          </select>
        </label>
        <button
          className="btn-ghost ml-auto"
          type="button"
          onClick={() =>
            downloadCsv(
              "active-authors",
              ["Author", "Source domain", "Source post", "Destination", "Published", "Freshness", "Detection", "Email", "Email status", "Phone", "Phone region", "Stage"],
              filtered.map((r) => [
                r.author_name,
                r.source_domain,
                r.source_post_url,
                r.destination_domain,
                r.published_at,
                r.freshness_score,
                r.detection_score,
                r.email,
                r.email_status,
                r.phone,
                r.phone_region,
                r.status,
              ]),
            )
          }
        >
          Export CSV
        </button>
        <button
          className="btn-ghost text-[var(--color-danger)]"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => deleteAuthors({ ids: [...selected] })}
          title="Remove the selected authors from the publisher history"
        >
          {`Delete ${selected.size || ""}`.trim()}
        </button>
        <button
          className="btn-ghost text-[var(--color-danger)]"
          type="button"
          disabled={busy || rows.length === 0}
          onClick={() => deleteAuthors({ all: true })}
          title="Clear the entire active-publisher history"
        >
          Clear all history
        </button>
        <button
          className="btn-primary"
          type="button"
          disabled={busy || verifiedSelectedCount === 0}
          onClick={addToCampaign}
          title="Adds verified authors to your contacts, ready to enroll in a campaign"
        >
          {busy ? "Adding…" : `Add ${verifiedSelectedCount || ""} to contacts`.trim()}
        </button>
      </div>

      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(allIds))}
                />
              </th>
              <th>Author</th>
              <th>Destination</th>
              <th>Guest post</th>
              <th>Fresh</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Stage</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="hint py-6 text-center">
                  No authors yet. Seed publishers above or use “Find authors” on a
                  discovery run.
                </td>
              </tr>
            )}
            {filtered.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    title={
                      row.email_status === "verified"
                        ? "Select to add to contacts or delete"
                        : "Not verified — select to delete (can't be added to contacts)"
                    }
                  />
                </td>
                <td>
                  <div className="font-medium">{row.author_name ?? "Unknown"}</div>
                  <div className="hint">via {row.source_domain}</div>
                </td>
                <td>
                  <a
                    href={`https://${row.destination_domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-brand)]"
                  >
                    {row.destination_domain}
                  </a>
                </td>
                <td className="max-w-[16rem] truncate">
                  <a
                    href={row.source_post_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hint"
                    title={row.latest_post_title ?? row.source_post_url}
                  >
                    {row.latest_post_title ?? row.source_post_url}
                  </a>
                </td>
                <td className="tabular-nums">{row.freshness_score ?? "—"}</td>
                <td className={EMAIL_TONE[row.email_status] ?? ""}>
                  {row.email ? (
                    <span title={row.email_status}>{row.email}</span>
                  ) : (
                    <span className="hint">—</span>
                  )}
                </td>
                <td className="hint">{row.phone ?? "—"}</td>
                <td>
                  <StageSelect entity="author" id={row.id} value={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
