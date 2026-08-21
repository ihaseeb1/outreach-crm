"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Clears dead enrolments (bounced, failed) out of a campaign so the enrolled
 * list is not clogged with contacts that will never advance. Optionally pushes
 * the bounced addresses onto the suppression list in the same action.
 */
export function CampaignPurgeButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [suppress, setSuppress] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function purge() {
    if (
      !window.confirm(
        "Remove all bounced and failed contacts from this campaign?" +
          (suppress ? " Bounced addresses will also be suppressed." : ""),
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const url = new URL("/api/campaigns/contacts", window.location.origin);
      url.searchParams.set("campaign_id", campaignId);
      url.searchParams.set("statuses", "bounced,failed");
      if (suppress) url.searchParams.set("suppress", "1");
      const res = await fetch(url.pathname + url.search, { method: "DELETE" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Failed.");
      setMsg(
        `Removed ${payload.removed}` +
          (payload.suppressed ? `, suppressed ${payload.suppressed}` : "") +
          ".",
      );
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={suppress}
          disabled={busy}
          onChange={(e) => setSuppress(e.target.checked)}
        />
        also suppress bounced
      </label>
      <button
        className="btn-secondary px-2.5 py-1.5 text-xs"
        type="button"
        disabled={busy}
        onClick={() => void purge()}
      >
        {busy ? "…" : "Clear bounced & failed"}
      </button>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}
