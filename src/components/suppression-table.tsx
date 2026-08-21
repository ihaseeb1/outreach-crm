"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  source: string | null;
  created_at: string;
}

/** Reasons the server will not remove without an explicit confirmation. */
const PROTECTED = new Set(["hard_bounce", "complaint"]);

/**
 * The suppression list, with a way to get things off it.
 *
 * Every row is deletable now, including bounces and complaints. Those were
 * previously shown as "locked" with no route past it, which is wrong in one
 * specific and recurring case: a bounce classified from wording rather than an
 * SMTP status code, on an address that is in fact fine. The protection stays,
 * as a confirmation rather than a wall.
 *
 * Filtering is done here rather than in a query. The page already loads the
 * list, and the number of entries a link-building workspace accumulates is in
 * the hundreds — small enough that a round trip per keystroke would be the
 * slower of the two.
 */
export function SuppressionTable({
  rows,
  total,
}: {
  rows: SuppressionRow[];
  /** Every entry in the workspace, which can be more than the page loaded. */
  total?: number;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const stored = total ?? rows.length;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (reason && row.reason !== reason) return false;
      if (!needle) return true;
      return (
        row.email.toLowerCase().includes(needle) ||
        (row.source ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rows, query, reason]);

  // Only ever the rows on screen: selecting, then filtering, then deleting must
  // not remove something the reader can no longer see.
  const visibleSelected = filtered.filter((row) => selected.has(row.id));
  const allVisibleSelected =
    filtered.length > 0 && visibleSelected.length === filtered.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Empties the list on the server, not row by row.
   *
   * Deleting the rows on screen is not the same thing: the page holds the
   * newest 1,000 entries, so a workspace with more than that would keep the
   * rest — and the reason for clearing is to stop storing them at all. The
   * filter and the search box scope it, so this button always means "everything
   * this screen is showing".
   */
  async function clearList() {
    const scoped = Boolean(query.trim() || reason);
    const label = scoped
      ? `every entry matching this filter (${filtered.length} shown)`
      : `all ${stored.toLocaleString()} entries`;

    if (
      !confirm(
        `Clear ${label} from the suppression list?

Every address removed can be emailed again by a campaign, a follow-up or warmup.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const params = new URLSearchParams({ all: "1" });
      if (reason) params.set("reason", reason);
      if (query.trim()) params.set("q", query.trim());

      let response = await fetch(`/api/suppressions?${params}`, {
        method: "DELETE",
      });
      let payload = await response.json().catch(() => null);

      // 409 is the server asking again about bounces and complaints. Asking
      // here, with its number in the question, rather than pre-empting it with
      // a guess made from the rows that happen to be loaded.
      if (response.status === 409) {
        if (!confirm(`${payload?.error ?? "Some of these bounced."}

Clear them anyway?`)) {
          setBusy(false);
          return;
        }
        params.set("confirm", "1");
        response = await fetch(`/api/suppressions?${params}`, { method: "DELETE" });
        payload = await response.json().catch(() => null);
      }

      if (!response.ok) throw new Error(payload?.error ?? "Could not clear the list.");

      setSelected(new Set());
      setNote(
        `Cleared ${Number(payload?.removed ?? 0).toLocaleString()} entr${
          Number(payload?.removed ?? 0) === 1 ? "y" : "ies"
        }.`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(targets: SuppressionRow[]) {
    if (targets.length === 0) return;

    const risky = targets.filter((row) => PROTECTED.has(row.reason));
    const summary =
      targets.length === 1
        ? targets[0]!.email
        : `${targets.length} addresses`;

    if (!confirm(`Remove ${summary} from the suppression list?`)) return;

    if (
      risky.length > 0 &&
      !confirm(
        `${risky.length} of those bounced or complained. Suppression is what stops you emailing an address that has already rejected you, and removing it risks your sending reputation.\n\nRemove them anyway?`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("ids", targets.map((row) => row.id).join(","));
      if (risky.length > 0) params.set("confirm", "1");

      const response = await fetch(`/api/suppressions?${params}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "Could not remove.");

      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--color-line)] px-5 py-3">
        <div className="min-w-52 flex-1">
          <label className="label" htmlFor="suppression-search">
            Search
          </label>
          <input
            id="suppression-search"
            className="input"
            placeholder="Address or source"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="suppression-reason">
            Reason
          </label>
          <select
            id="suppression-reason"
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          >
            <option value="">All</option>
            <option value="manual">Manual</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="opted_out">Opted out</option>
            <option value="complaint">Complaint</option>
            <option value="hard_bounce">Hard bounce</option>
          </select>
        </div>
        <button
          className="btn-danger"
          type="button"
          disabled={busy || visibleSelected.length === 0}
          onClick={() => remove(visibleSelected)}
        >
          {busy
            ? "Removing…"
            : `Delete selected${visibleSelected.length ? ` (${visibleSelected.length})` : ""}`}
        </button>
        <button
          className="btn-danger"
          type="button"
          disabled={busy || stored === 0}
          onClick={() => void clearList()}
          title="Deletes every entry on the server, not just the ones loaded on this page."
        >
          {query.trim() || reason
            ? "Clear filtered"
            : `Clear the list${stored ? ` (${stored.toLocaleString()})` : ""}`}
        </button>
      </div>

      {error && (
        <p className="border-b border-[var(--color-line)] px-5 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {note && (
        <p className="border-b border-[var(--color-line)] px-5 py-2 text-sm text-[var(--color-ok)]">
          {note}
        </p>
      )}

      {filtered.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">
          {rows.length === 0
            ? "Nothing suppressed yet."
            : "No entries match that search."}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all shown"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelected(
                        allVisibleSelected
                          ? new Set()
                          : new Set(filtered.map((row) => row.id)),
                      )
                    }
                  />
                </th>
                <th>Email</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.email}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </td>
                  <td className="font-medium">{row.email}</td>
                  <td>
                    {row.reason.replace("_", " ")}
                    {PROTECTED.has(row.reason) && (
                      <span
                        className="hint ml-1"
                        title="Removing this one asks twice — it risks your sending reputation."
                      >
                        (protected)
                      </span>
                    )}
                  </td>
                  <td>{row.source ?? "—"}</td>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td className="text-right">
                    <button
                      className="btn-danger px-2 py-1 text-xs"
                      type="button"
                      disabled={busy}
                      onClick={() => remove([row])}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint border-t border-[var(--color-line)] px-5 py-2">
        Showing {filtered.length} of {rows.length}
        {stored > rows.length && ` (${stored.toLocaleString()} stored)`}. Deleting
        an entry means the address can be emailed again — by a campaign, a
        follow-up or warmup. <strong>Clear the list</strong> empties it on the
        server, including entries past the {rows.length.toLocaleString()} loaded
        here.
      </p>
    </section>
  );
}
