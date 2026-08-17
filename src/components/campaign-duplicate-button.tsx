"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Copies the sequence and settings into a fresh draft and opens it, so the next
 * list can be started without rebuilding the emails by hand.
 */
export function CampaignDuplicateButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function duplicate() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/campaigns/duplicate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: campaignId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not duplicate.");
      router.push(`/campaigns/${payload.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        className="btn-secondary"
        type="button"
        disabled={busy}
        onClick={() => void duplicate()}
      >
        {busy ? "Duplicating…" : "Duplicate"}
      </button>
      <p className="hint text-right">
        Copies the sequence, schedule and mailboxes into a new draft. Contacts
        are not copied.
      </p>
      {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}
