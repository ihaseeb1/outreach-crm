"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { pairColumns, parseContactImport, separateCombined } from "@/lib/import-parse";

interface ImportResult {
  parsed: number;
  added: number;
  duplicates: number;
  queued: number;
  truncated: number;
  skipped: { line: string; reason: string }[];
  skippedTotal: number;
}

type Mode = "combined" | "two" | "single";

const countLines = (value: string) =>
  value.split(/\r?\n/).filter((line) => line.trim()).length;

/**
 * Bulk contact import.
 *
 * Three ways in, all feeding the same parser that runs on the server, so the
 * live count can never disagree with what gets saved:
 *
 *  - **Both columns together** (the default). Paste the whole two-column
 *    selection straight out of Google Sheets — websites and emails in one block
 *    — and one click separates it into the two boxes. This is the everyday case:
 *    copying two adjacent columns gives one block, not two.
 *  - **Two separate boxes** — website column in one, email column in the other —
 *    for when they are already split.
 *  - **One per line** — website and email on the same line — and file uploads.
 */
export function ContactImportForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("combined");
  const [combined, setCombined] = useState("");
  const [websites, setWebsites] = useState("");
  const [emails, setEmails] = useState("");
  const [text, setText] = useState("");
  const [scrapeWebsites, setScrapeWebsites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const paired = mode === "combined" || mode === "two";

  // The preview always reads the two boxes when paired — in combined mode they
  // are empty until Separate has run, which is exactly the intended flow: paste,
  // separate, check the split, import.
  const preview = useMemo(
    () => (paired ? pairColumns(websites, emails) : parseContactImport(text)),
    [paired, websites, emails, text],
  );

  const siteLines = countLines(websites);
  const mailLines = countLines(emails);
  const mismatch = paired && siteLines > 0 && mailLines > 0 && siteLines !== mailLines;
  const nothingToDo =
    preview.rows.length === 0 && preview.websitesOnly.length === 0;

  function separate() {
    const { websites: w, emails: e } = separateCombined(combined);
    if (!w && !e) {
      setNote(
        "Couldn't find any websites or emails in that. Make sure it's the two columns copied together.",
      );
      return;
    }
    setWebsites(w);
    setEmails(e);
    setCombined("");
    setMode("two");
    setNote(
      `Separated into ${countLines(w)} website(s) and ${countLines(e)} email(s). Check the split below, then import.`,
    );
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setMode("single");
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
      setCombined("");
      setWebsites("");
      setEmails("");
      setText("");
      setNote(null);
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

      {mode === "combined" && (
        <>
          <div>
            <label className="label" htmlFor="import-combined">
              Paste both columns together
            </label>
            <textarea
              id="import-combined"
              className="input min-h-48 font-mono text-xs"
              placeholder={
                "Copy the website column and the email column together from\n" +
                "Google Sheets and paste here:\n\n" +
                "example.com\tjane@example.com\n" +
                "another-site.co.uk\teditor@another-site.co.uk\n" +
                "thirdsite.net\thello@thirdsite.net"
              }
              value={combined}
              onChange={(e) => {
                setCombined(e.target.value);
                setNote(null);
              }}
            />
          </div>
          <p className="hint">
            One paste for both columns. Click{" "}
            <strong>Separate into website + email</strong> and each half drops
            into its own box, lined up row by row, so you can check the split
            before importing. Tab, comma or space between the two works, in
            either order.
          </p>
          <button
            className="btn-primary"
            type="button"
            disabled={busy || !combined.trim()}
            onClick={separate}
          >
            Separate into website + email
          </button>
        </>
      )}

      {mode === "two" && (
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
      )}

      {mode === "single" && (
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

      {note && <p className="text-xs text-[var(--color-brand)]">{note}</p>}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {mode !== "combined" && (
          <button
            className="text-[var(--color-brand)] hover:underline"
            type="button"
            onClick={() => {
              setMode("combined");
              setNote(null);
            }}
          >
            Paste both columns together
          </button>
        )}
        {mode !== "two" && (
          <button
            className="text-[var(--color-brand)] hover:underline"
            type="button"
            onClick={() => {
              setMode("two");
              setNote(null);
            }}
          >
            Use two separate boxes
          </button>
        )}
        {mode !== "single" && (
          <button
            className="text-[var(--color-brand)] hover:underline"
            type="button"
            onClick={() => {
              setMode("single");
              setNote(null);
            }}
          >
            My list is one-per-line
          </button>
        )}
      </div>

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
