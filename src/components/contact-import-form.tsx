"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { parseContactImport } from "@/lib/import-parse";

interface ImportResult {
  parsed: number;
  added: number;
  duplicates: number;
  queued: number;
  truncated: number;
  skipped: { line: string; reason: string }[];
  skippedTotal: number;
}

/**
 * Paste a list of websites and emails.
 *
 * The same parser runs in the browser for the live preview and on the server
 * for the real import, so what the preview counts is exactly what gets saved.
 */
export function ContactImportForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [scrapeWebsites, setScrapeWebsites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const preview = useMemo(() => parseContactImport(text), [text]);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText((current) => (current ? `${current}\n${content}` : content));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, scrapeWebsites }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Import failed.");
      setResult(payload as ImportResult);
      setText("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn-secondary" type="button" onClick={() => setOpen(true)}>
        Paste a list
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad w-full space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Paste websites and emails</h2>
        <button className="hint hover:underline" type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      <textarea
        className="input min-h-48 font-mono text-xs"
        placeholder={
          "example.com, jane@example.com\n" +
          "https://another-site.co.uk\teditor@another-site.co.uk\n" +
          "hello@thirdsite.net\n" +
          "sitewithnoemail.com"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <p className="hint">
        One per line. Website and email in either order, separated by a tab,
        comma or space — so a straight copy out of a spreadsheet works. An email
        on its own is fine; the domain is taken from the address. A website on
        its own is queued for scraping instead, since there is no address yet.
        A header row is ignored.
      </p>

      {text.trim() && (
        <div className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs">
          <strong>{preview.rows.length}</strong> contact(s)
          {preview.websitesOnly.length > 0 && (
            <>
              {" · "}
              <strong>{preview.websitesOnly.length}</strong> website(s) to scrape
            </>
          )}
          {preview.skipped.length > 0 && (
            <>
              {" · "}
              <span className="text-[var(--color-warn)]">
                <strong>{preview.skipped.length}</strong> line(s) unreadable
              </span>
            </>
          )}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={scrapeWebsites}
          onChange={(e) => setScrapeWebsites(e.target.checked)}
        />
        Also scrape the websites that came with an address, to find more people
        there
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          type="submit"
          disabled={busy || (preview.rows.length === 0 && preview.websitesOnly.length === 0)}
        >
          {busy ? "Importing…" : "Import"}
        </button>

        <label className="btn-secondary cursor-pointer">
          Upload .txt / .csv
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.tsv,text/plain,text/csv"
            className="hidden"
            onChange={onFile}
          />
        </label>
      </div>

      {result && (
        <div className="space-y-1 text-sm text-[var(--color-ok)]">
          <p>
            Added {result.added} contact(s)
            {result.duplicates > 0 && `, ${result.duplicates} already existed`}
            {result.queued > 0 && `, queued ${result.queued} website(s) for scraping`}.
          </p>
          {result.truncated > 0 && (
            <p className="text-[var(--color-warn)]">
              {result.truncated} row(s) past the 5,000 limit were not imported —
              paste the rest separately.
            </p>
          )}
          {result.skippedTotal > 0 && (
            <details className="text-[var(--color-warn)]">
              <summary className="cursor-pointer">
                {result.skippedTotal} line(s) could not be read
              </summary>
              <ul className="ml-4 mt-1 list-disc font-mono text-xs">
                {result.skipped.map((row, index) => (
                  <li key={index}>
                    {row.line.slice(0, 80)} — {row.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
