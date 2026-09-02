"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Seeds the author crawl from pasted publisher domains — the standalone entry
 * point for Feature 2 (no SERP run required). The worker then finds each
 * publisher's recent guest authors.
 */
export function PublisherSeedForm() {
  const router = useRouter();
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/publishers/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domains }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to seed.");
      const parts = [
        `Scraped ${payload.scraped} site(s): ${payload.withEmail} with an email`,
        `${payload.verified} verified`,
      ];
      if (payload.queued > 0) parts.push(`${payload.queued} queued for the worker`);
      setMessage(`${parts.join(", ")}.`);
      setDomains("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-3">
      <div>
        <label className="label" htmlFor="domains">
          Find contacts for a list of sites
        </label>
        <textarea
          id="domains"
          className="input min-h-24 font-mono text-xs"
          placeholder={"techblog.com\nhttps://another-site.io"}
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
        <p className="hint mt-1">
          One domain or URL per line. We crawl each site right now for its best
          contact email (verified) and phone — the first 8 come back live; more
          are queued for the background worker.
        </p>
      </div>
      <button className="btn-primary" type="submit" disabled={busy || !domains.trim()}>
        {busy ? "Scraping… (up to a minute)" : "Find contacts"}
      </button>
      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
