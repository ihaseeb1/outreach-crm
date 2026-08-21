"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { pairColumns, parseContactImport } from "@/lib/import-parse";

interface ImportResult {
  parsed: number;
  added: number;
  duplicates: number;
  queued: number;
  truncated: number;
  skipped: { line: string; reason: string }[];
  skippedTotal: number;
}

const countLines = (value: string) =>
  value.split(/\r?\n/).filter((line) => line.trim()).length;

/**
 * Bulk contact import.
 *
 * Two boxes by default — paste the website column in one and the email column
 * in the other, exactly as they come out of a spreadsheet, and they are matched
 * row by row. No reformatting every line into "site, email" by hand.
 *
 * The combined single-box mode is kept behind a toggle for lists that are
 * already one-per-line, and for file uploads.
 *
 * The same parser runs here and on the server, so the live count cannot
 * disagree with what actually gets saved.
 */
export function ContactImportForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [paired, setPaired] = useState(true);
  const [websites, setWebsites] = useState("");
  const [emails, setEmails] = useState("");
  const [text, setText] = useState("");
  const [scrapeWebsites, setScrapeWebsites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(
    () => (paired ? pairColumns(websites, emails) : parseContactImport(text)),
    [paired, websites, emails, text],
  );

  const siteLines = countLines(websites);
  const mailLines = countLines(emails);
  const mismatch = paired && siteLines > 0 && mailLines > 0 && siteLines !== mailLines;
  const nothingToDo =
    preview.rows.length === 0 && preview.websitesOnly.length === 0;

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setPaired(false);
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
        body: JSON.stringify(
          paired
            ? { websites, emails, scrapeWebsites }
            : { text, scrapeWebsites },
        ),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Import failed.");
      setResult(payload as ImportResult);
      setWebsites("");
      setEmails("");
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
        <h2 className="text-sm font-semibold">Import contacts</h2>
        <button className="hint hover:underline" type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {paired ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="import-websites">
                Websites {siteLines > 0 && <span className="hint">({siteLines})</span>}
              </label>
              <textarea
                id="import-websites"
                className="input min-h-48 font-mono text-xs"
                placeholder={
                  "example.com\nanother-site.co.uk\nthirdsite.net" +
                  "\n\n…or both halves per line:\nfacebook.com,info@facebook.com"
                }
                value={websites}
                onChange={(e) => setWebsites(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="import-emails">
                Emails {mailLines > 0 && <span className="hint">({mailLines})</span>}
              </label>
              <textarea
                id="import-emails"
                className="input min-h-48 font-mono text-xs"
                placeholder={
                  "jane@example.com\neditor@another-site.co.uk\nhello@thirdsite.net"
                }
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
              />
            </div>
          </div>

          <p className="hint">
            Paste each column straight from your spreadsheet. Row 1 pairs with
            row 1, row 2 with row 2, and so on. You can fill in just one box:
            emails alone still create contacts, websites alone get queued for
            scraping.
          </p>
          <p className="hint">
            Both halves on one line works too —{" "}
            <code>facebook.com,info@facebook.com</code> pasted into either box is
            split into the website and the address. The count below is what will
            actually be saved, so you can check it before importing.
          </p>

          {mismatch && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-[var(--color-warn)]">
              {siteLines} website(s) but {mailLines} email(s). They are still
              paired by row —{" "}
              {siteLines > mailLines
                ? `the last ${siteLines - mailLines} website(s) have no address and will be queued for scraping instead.`
                : `the last ${mailLines - siteLines} email(s) have no website and will take their domain from the address.`}{" "}
              If your columns had a blank cell in the middle, keep the blank line
              so the rows stay lined up.
            </p>
          )}
        </>
      ) : (
        <div>
          <label className="label" htmlFor="import-text">
            One per line
          </label>
          <textarea
            id="import-text"
            className="input min-h-48 font-mono text-xs"
            placeholder={
              "example.com, jane@example.com\n" +
              "another-site.co.uk\teditor@another-site.co.uk\n" +
              "hello@thirdsite.net"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="hint mt-1">
            Website and email on the same line, in either order, separated by a
            tab, comma or space. A header row is ignored.
          </p>
        </div>
      )}

      <button
        className="text-xs text-[var(--color-brand)] hover:underline"
        type="button"
        onClick={() => setPaired((current) => !current)}
      >
        {paired
          ? "My list is already one-per-line instead"
          : "Use two separate boxes instead"}
      </button>

      {(preview.rows.length > 0 ||
        preview.websitesOnly.length > 0 ||
        preview.skipped.length > 0) && (
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
                <strong>{preview.skipped.length}</strong> unreadable
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
        <button className="btn-primary" type="submit" disabled={busy || nothingToDo}>
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
