"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { countFound, parseQuote, type ParsedQuote } from "@/deals/parse-quote";
import type { DealStatus, DealWithPrices } from "@/types/db";

export interface DealFormDefaults {
  id?: string;
  contact_id?: string | null;
  conversation_id?: string | null;
  domain?: string;
}

interface PriceRow {
  niche: string;
  price: string;
}

const COMMON_NICHES = [
  "General",
  "Business",
  "Tech",
  "Health",
  "Finance",
  "Crypto",
  "Casino",
  "CBD",
  "Adult",
  "Dating",
];

const STATUSES: DealStatus[] = [
  "negotiating",
  "agreed",
  "ordered",
  "live",
  "rejected",
];

/** What POST /api/deals reports back, beyond the row it saved. */
export interface DealSaveResult {
  ok: boolean;
  id: string;
  stopped_sequences?: number;
  /** Set when the thread was starred in the real mailbox. */
  starred?: { folder: string; mailbox: string } | null;
  /** Set when starring was attempted and could not be done. */
  star_error?: string | null;
}

/**
 * The rate card. Everything a publisher quotes in a reply, in one form:
 * per-niche prices, turnaround, link and placement type, manual metrics, content
 * rules, and payment terms.
 */
export function DealForm({
  defaults,
  existing,
  onSaved,
  compact,
  quoteSource,
}: {
  defaults?: DealFormDefaults;
  existing?: DealWithPrices | null;
  /** Receives the API payload, so a caller can report what else happened. */
  onSaved?: (result: DealSaveResult) => void;
  compact?: boolean;
  /** Their reply, so the rate card can be read off it instead of retyped. */
  quoteSource?: string | null;
}) {
  const router = useRouter();

  const [domain, setDomain] = useState(existing?.domain ?? defaults?.domain ?? "");
  const [status, setStatus] = useState<DealStatus>(existing?.status ?? "negotiating");
  const [currency, setCurrency] = useState(existing?.currency ?? "USD");
  const [linkType, setLinkType] = useState(existing?.link_type ?? "dofollow");
  const [placement, setPlacement] = useState(existing?.placement_type ?? "guest post");
  const [tat, setTat] = useState(existing?.tat_days?.toString() ?? "");
  const [da, setDa] = useState(existing?.da?.toString() ?? "");
  const [dr, setDr] = useState(existing?.dr?.toString() ?? "");
  const [traffic, setTraffic] = useState(existing?.monthly_traffic?.toString() ?? "");
  const [spam, setSpam] = useState(existing?.spam_score?.toString() ?? "");
  const [wordCount, setWordCount] = useState(existing?.word_count?.toString() ?? "");
  const [contentBy, setContentBy] = useState(existing?.content_by ?? "us");
  const [maxLinks, setMaxLinks] = useState(existing?.max_links?.toString() ?? "");
  const [paymentTerms, setPaymentTerms] = useState(existing?.payment_terms ?? "");
  const [paymentMethod, setPaymentMethod] = useState(existing?.payment_method ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [prices, setPrices] = useState<PriceRow[]>(
    existing?.deal_prices?.length
      ? existing.deal_prices.map((price) => ({
          niche: price.niche,
          price: String(price.price),
        }))
      : [{ niche: "General", price: "" }],
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [paste, setPaste] = useState("");
  const [read, setRead] = useState<ParsedQuote | null>(null);
  const [readNote, setReadNote] = useState<string | null>(null);

  /**
   * Fills the blanks from their email and leaves anything already typed alone.
   *
   * Overwriting is the one thing a shortcut like this must not do: a price
   * corrected by hand and then silently replaced by the parser is worse than no
   * parser at all. Everything filled stays editable, and every value is shown
   * with the line it was read from underneath.
   */
  function applyQuote(text: string) {
    const quote = parseQuote(text);
    const found = countFound(quote);

    if (found === 0) {
      setRead(null);
      setReadNote(
        "Nothing recognisable in that text — no prices, metrics or terms. Fill the form in by hand.",
      );
      return;
    }

    const fillBlank = (
      current: string,
      setter: (value: string) => void,
      value: string | number | null,
    ) => {
      if (value === null || current.trim()) return;
      setter(String(value));
    };

    if (quote.currency && !existing) setCurrency(quote.currency);

    // Price rows count as blank while they are still the untouched "General"
    // placeholder the form opens with.
    const pricesUntouched = prices.every((row) => !row.price.trim());
    if (quote.prices.length > 0 && pricesUntouched) {
      setPrices(quote.prices.map((row) => ({ niche: row.niche, price: String(row.price) })));
    }

    fillBlank(tat, setTat, quote.tatDays);
    fillBlank(da, setDa, quote.da);
    fillBlank(dr, setDr, quote.dr);
    fillBlank(traffic, setTraffic, quote.monthlyTraffic);
    fillBlank(spam, setSpam, quote.spamScore);
    fillBlank(wordCount, setWordCount, quote.wordCount);
    fillBlank(maxLinks, setMaxLinks, quote.maxLinks);
    fillBlank(paymentTerms, setPaymentTerms, quote.paymentTerms);
    fillBlank(paymentMethod, setPaymentMethod, quote.paymentMethod);

    // These three open with a default rather than empty, so "blank" cannot be
    // the test — an unedited default is replaced by what they actually quoted.
    if (quote.linkType && linkType === "dofollow") setLinkType(quote.linkType);
    if (quote.placementType && placement === "guest post") setPlacement(quote.placementType);
    if (quote.contentBy && contentBy === "us") setContentBy(quote.contentBy);

    setRead(quote);
    setReadNote(
      `Read ${found} value${found === 1 ? "" : "s"} from their email. Anything you had already typed was left alone — check the figures below against what they wrote.`,
    );
  }

  const num = (value: string): number | null => {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: existing?.id ?? defaults?.id,
          contact_id: existing?.contact_id ?? defaults?.contact_id ?? null,
          conversation_id:
            existing?.conversation_id ?? defaults?.conversation_id ?? null,
          domain,
          status,
          currency,
          link_type: linkType || null,
          placement_type: placement || null,
          tat_days: num(tat),
          da: num(da),
          dr: num(dr),
          monthly_traffic: num(traffic),
          spam_score: num(spam),
          word_count: num(wordCount),
          content_by: contentBy || null,
          max_links: num(maxLinks),
          payment_terms: paymentTerms || null,
          payment_method: paymentMethod || null,
          notes: notes || null,
          prices: prices
            .filter((row) => row.niche.trim() && row.price.trim())
            .map((row) => ({
              niche: row.niche.trim(),
              price: Number(row.price),
              currency,
            })),
        }),
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");

      setSaved(true);
      router.refresh();
      onSaved?.(payload as DealSaveResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <fieldset className="rounded-md border border-[var(--color-line)] p-4">
        <legend className="px-1 text-sm font-medium">Fill from their email</legend>
        <p className="hint">
          Reads the prices, niches and requirements straight out of what they
          wrote — rates by niche, DA/DR, traffic, turnaround, link type, word
          count, payment terms. Blanks only: nothing you have typed is replaced.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {quoteSource && (
            <button
              className="btn-secondary px-2.5 py-1.5 text-xs"
              type="button"
              onClick={() => applyQuote(quoteSource)}
            >
              Read their reply
            </button>
          )}
          <button
            className="btn-secondary px-2.5 py-1.5 text-xs"
            type="button"
            disabled={!paste.trim()}
            onClick={() => applyQuote(paste)}
          >
            Read pasted text
          </button>
        </div>

        <textarea
          className="input mt-2 min-h-20 text-sm"
          placeholder={
            quoteSource
              ? "…or paste a quote from anywhere else — Gmail, WhatsApp, a rate card."
              : "Paste their email or rate card here."
          }
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />

        {readNote && <p className="hint mt-2">{readNote}</p>}

        {read && Object.keys(read.evidence).length > 0 && (
          <details className="mt-2">
            <summary className="hint cursor-pointer select-none">
              Show what each value was read from
            </summary>
            <ul className="mt-2 space-y-1">
              {Object.entries(read.evidence).map(([field, line]) => (
                <li key={field} className="text-xs text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--color-ink)]">
                    {field.replace(/^price:/, "").replace(/([A-Z])/g, " $1").toLowerCase()}
                  </span>{" "}
                  — “{line}”
                </li>
              ))}
            </ul>
          </details>
        )}
      </fieldset>

      <div className={`grid gap-3 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        <div>
          <label className="label" htmlFor="deal-domain">
            Domain
          </label>
          <input
            id="deal-domain"
            className="input"
            required
            placeholder="publisher.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="deal-status">
            Status
          </label>
          <select
            id="deal-status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as DealStatus)}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="deal-currency">
            Currency
          </label>
          <input
            id="deal-currency"
            className="input"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </div>
      </div>

      <fieldset className="rounded-md border border-[var(--color-line)] p-4">
        <legend className="px-1 text-sm font-medium">Prices by niche</legend>
        <div className="space-y-2">
          {prices.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <input
                className="input flex-1 min-w-32"
                list="common-niches"
                placeholder="Niche"
                value={row.niche}
                onChange={(e) =>
                  setPrices((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, niche: e.target.value } : item,
                    ),
                  )
                }
              />
              <input
                className="input w-32"
                type="number"
                min={0}
                step="0.01"
                placeholder="Price"
                value={row.price}
                onChange={(e) =>
                  setPrices((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, price: e.target.value } : item,
                    ),
                  )
                }
              />
              {prices.length > 1 && (
                <button
                  className="hint text-[var(--color-danger)] hover:underline"
                  type="button"
                  onClick={() =>
                    setPrices((current) => current.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        <datalist id="common-niches">
          {COMMON_NICHES.map((niche) => (
            <option key={niche} value={niche} />
          ))}
        </datalist>

        <button
          className="btn-secondary mt-3 px-2.5 py-1.5 text-xs"
          type="button"
          onClick={() => setPrices((current) => [...current, { niche: "", price: "" }])}
        >
          Add niche
        </button>
        <p className="hint mt-2">
          One row per niche the publisher quotes — General 150, Casino 400, CBD
          350, and so on. Each becomes its own column in the Excel export.
        </p>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Link type" value={linkType} onChange={setLinkType} list="link-types" />
        <datalist id="link-types">
          <option value="dofollow" />
          <option value="nofollow" />
          <option value="sponsored" />
        </datalist>
        <Field
          label="Placement"
          value={placement}
          onChange={setPlacement}
          list="placement-types"
        />
        <datalist id="placement-types">
          <option value="guest post" />
          <option value="niche edit" />
          <option value="link insertion" />
          <option value="homepage" />
          <option value="press release" />
        </datalist>
        <Field label="TAT (days)" value={tat} onChange={setTat} type="number" />
        <Field label="Max links" value={maxLinks} onChange={setMaxLinks} type="number" />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="DA" value={da} onChange={setDa} type="number" />
        <Field label="DR" value={dr} onChange={setDr} type="number" />
        <Field
          label="Monthly traffic"
          value={traffic}
          onChange={setTraffic}
          type="number"
        />
        <Field label="Spam score" value={spam} onChange={setSpam} type="number" />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Field
          label="Word count"
          value={wordCount}
          onChange={setWordCount}
          type="number"
        />
        <Field label="Content by" value={contentBy} onChange={setContentBy} list="content-by" />
        <datalist id="content-by">
          <option value="us" />
          <option value="publisher" />
          <option value="either" />
        </datalist>
        <Field
          label="Payment method"
          value={paymentMethod}
          onChange={setPaymentMethod}
          list="payment-methods"
        />
        <datalist id="payment-methods">
          <option value="PayPal" />
          <option value="Wise" />
          <option value="Bank transfer" />
          <option value="Payoneer" />
          <option value="Crypto" />
        </datalist>
        <Field
          label="Payment terms"
          value={paymentTerms}
          onChange={setPaymentTerms}
        />
      </div>

      <div>
        <label className="label" htmlFor="deal-notes">
          Notes
        </label>
        <textarea
          id="deal-notes"
          className="input min-h-20"
          placeholder="Anything else they said — discounts for bulk, niches they refuse, who to chase…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" type="submit" disabled={busy || !domain.trim()}>
          {busy ? "Saving…" : existing ? "Update deal" : "Save deal"}
        </button>
        {saved && <span className="hint text-[var(--color-ok)]">Saved.</span>}
        {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  list,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  list?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type={type}
        list={list}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
