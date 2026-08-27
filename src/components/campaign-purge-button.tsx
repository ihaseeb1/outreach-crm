"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { cleanupStatuses } from "@/campaigns/cleanup";

/**
 * One-click campaign cleanup (spec §8).
 *
 * Clears dead enrolments out of a campaign so the enrolled list is not clogged
 * with contacts that will never advance. Bounced and failed always; tick
 * "also finished & opted-out" to additionally clear contacts that ran the whole
 * sequence with no reply (completed) or unsubscribed. Bounced addresses can be
 * pushed onto the suppression list in the same action. A live sequence is never
 * touched — the server only accepts dead-end statuses.
 */
export function CampaignPurgeButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [suppress, setSuppress] = useState(false);
  const [finished, setFinished] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function purge() {
    const statuses = cleanupStatuses({ finished });
    if (
      !window.confirm(
        `Remove all ${statuses.join(", ")} contacts from this campaign?` +
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
      url.searchParams.set("statuses", statuses.join(","));
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
          checked={finished}
          disabled={busy}
          onChange={(e) => setFinished(e.target.checked)}
        />
        also finished &amp; opted-out
      </label>
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
        {busy ? "…" : finished ? "Clean up enrolments" : "Clear bounced & failed"}
      </button>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}
