"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CampaignCreateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not create.");
      router.push(`/campaigns/${payload.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-3">
      <div>
        <label className="label" htmlFor="campaign-name">
          New campaign
        </label>
        <input
          id="campaign-name"
          className="input"
          placeholder="Q3 guest post outreach"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <p className="hint mt-1">
          Starts as a draft with a 3-step sequence you can edit. Open it to set
          the sending window (hours, days, timezone) and pick which mailboxes it
          rotates across — it defaults to 9–17 UTC, Mon–Fri.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      <button className="btn-primary" type="submit" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}
