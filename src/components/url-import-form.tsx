"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/** Paste or upload a list of website URLs; creates a scrape job. */
export function UrlImportForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const count = urls.split(/[\s,;]+/).filter(Boolean).length;

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    // Handles .txt one-per-line and single-column .csv exports alike.
    const extracted = text
      .split(/\r?\n/)
      .map((line) => line.split(",")[0]?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
    setUrls((current) => (current ? `${current}\n${extracted}` : extracted));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/scrape-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not queue job.");

      setResult(
        `Queued ${payload.queued} website(s)${
          payload.rejected ? `, skipped ${payload.rejected} invalid` : ""
        }.`,
      );
      setUrls("");
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
        <label className="label" htmlFor="urls">
          Website URLs
        </label>
        <textarea
          id="urls"
          className="input min-h-40 font-mono text-xs"
          placeholder={"example.com\nhttps://another-site.co.uk/\nblog.example.net"}
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
        />
        <p className="hint mt-1">
          One per line, or comma separated. {count > 0 && `${count} line(s). `}
          Scraping respects robots.txt and waits between requests.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" type="submit" disabled={busy || count === 0}>
          {busy ? "Queueing…" : "Queue scrape job"}
        </button>

        <label className="btn-secondary cursor-pointer">
          Upload .txt / .csv
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            className="hidden"
            onChange={onFile}
          />
        </label>
      </div>

      {result && <p className="text-sm text-[var(--color-ok)]">{result}</p>}
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
