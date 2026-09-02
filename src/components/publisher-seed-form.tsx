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
      setMessage(`Queued ${payload.seeded} publisher(s) for author crawl.`);
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
          Crawl publishers for recent authors
        </label>
        <textarea
          id="domains"
          className="input min-h-24 font-mono text-xs"
          placeholder={"techblog.com\nhttps://another-site.io"}
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
        <p className="hint mt-1">
          One domain or URL per line. We&apos;ll find posts from the last 30 days,
          detect the guest ones, and resolve each author&apos;s own site. Or use{" "}
          <b>Find authors</b> on a discovery run&apos;s results.
        </p>
      </div>
      <button className="btn-primary" type="submit" disabled={busy || !domains.trim()}>
        {busy ? "Queuing…" : "Queue author crawl"}
      </button>
      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
