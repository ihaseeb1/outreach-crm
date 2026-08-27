"use client";

import { useState } from "react";

import { DealForm } from "@/components/deal-form";

/** Export controls plus the "add a deal by hand" form. */
export function DealsToolbar({
  query,
  placementReady = false,
}: {
  query: string;
  /** Migration 0012 applied — show the placement fields on the new-deal form. */
  placementReady?: boolean;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function copyForExcel() {
    setCopied(null);
    try {
      const response = await fetch(
        `/api/deals/export?format=tsv${query ? `&${query}` : ""}`,
      );
      if (!response.ok) throw new Error("Export failed.");
      const tsv = await response.text();
      await navigator.clipboard.writeText(tsv);
      setCopied("Copied — paste straight into Excel or Sheets.");
    } catch (error) {
      setCopied(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn-secondary" href={`/api/deals/export?format=xlsx&${query}`}>
          Download Excel
        </a>
        <a className="btn-secondary" href={`/api/deals/export?format=csv&${query}`}>
          Download CSV
        </a>
        <button className="btn-secondary" type="button" onClick={copyForExcel}>
          Copy for Excel
        </button>
        <button
          className="btn-primary"
          type="button"
          onClick={() => setShowForm((current) => !current)}
        >
          {showForm ? "Cancel" : "Add deal"}
        </button>
        {copied && <span className="hint">{copied}</span>}
      </div>

      {showForm && (
        <div className="card card-pad">
          <h2 className="mb-3 text-sm font-semibold">New deal</h2>
          <DealForm
            placementReady={placementReady}
            onSaved={() => setShowForm(false)}
          />
        </div>
      )}
    </div>
  );
}
