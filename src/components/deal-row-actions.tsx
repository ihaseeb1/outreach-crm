"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DealForm } from "@/components/deal-form";
import type { DealWithPrices } from "@/types/db";

/**
 * Edit and delete for one row of the deals table.
 *
 * The editor opens in an overlay rather than expanding the row. A rate card is a
 * thirty-field form and the table is already wide enough to scroll sideways;
 * unfolding that inside a `<tr>` would either break the column alignment or
 * force a `colSpan` cell taller than the screen.
 *
 * `POST /api/deals` with an `id` already updated in place — it is what the inbox
 * uses when a publisher revises a quote — so this needed no new endpoint, just a
 * way to reach it from the page where the deals actually are.
 */
export function DealRowActions({ deal }: { deal: DealWithPrices }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    const prices = deal.deal_prices?.length ?? 0;
    if (
      !confirm(
        `Delete the deal for ${deal.domain}? ${
          prices > 0
            ? `Its ${prices} niche price${prices === 1 ? "" : "s"} go with it. `
            : ""
        }This cannot be undone — the contact and the email thread are untouched.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/deals?id=${deal.id}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not delete.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 whitespace-nowrap">
        <button
          className="text-xs font-medium text-[var(--color-brand)] hover:underline"
          type="button"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          className="text-xs font-medium text-[var(--color-danger)] hover:underline"
          type="button"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>

      {error && (
        <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>
      )}

      {editing && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Edit the deal for ${deal.domain}`}
          // Clicking the backdrop closes; clicking inside the panel must not,
          // or every keystroke that bubbles from a field would shut the form.
          onClick={(event) => {
            if (event.target === event.currentTarget) setEditing(false);
          }}
        >
          <div className="mx-auto my-8 max-w-3xl rounded-lg bg-[var(--color-surface)] p-5 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Edit deal</h2>
                <p className="hint">{deal.domain}</p>
              </div>
              <button
                className="btn-secondary px-2.5 py-1.5 text-xs"
                type="button"
                onClick={() => setEditing(false)}
              >
                Close
              </button>
            </div>

            <DealForm
              existing={deal}
              quoteSource={deal.notes}
              onSaved={() => setEditing(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
