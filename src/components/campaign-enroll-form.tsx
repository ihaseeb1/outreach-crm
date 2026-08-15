"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Adds contacts to a campaign using the same filters as the Contacts page. */
export function CampaignEnrollForm({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/campaigns/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaignId,
          filter: { domain: domain || undefined, limit },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not add contacts.");

      const parts = [`Added ${payload.added}`];
      if (payload.alreadyEnrolled) parts.push(`${payload.alreadyEnrolled} already in`);
      if (payload.skippedSuppressed) parts.push(`${payload.skippedSuppressed} suppressed`);
      if (payload.skippedUnvalidated) parts.push(`${payload.skippedUnvalidated} unvalidated`);
      setMessage(`${parts.join(", ")}.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-3">
      <h2 className="text-sm font-semibold">Add contacts</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="enroll-domain">
            Domain contains (optional)
          </label>
          <input
            id="enroll-domain"
            className="input"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="enroll-limit">
            Max to add
          </label>
          <input
            id="enroll-limit"
            className="input"
            type="number"
            min={1}
            max={5000}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </div>
      </div>

      <p className="hint">
        Only validated addresses are added. Anything on the suppression list is
        refused here as well as at send time.
      </p>

      <button className="btn-primary" type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add matching contacts"}
      </button>

      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
