"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { countFound, parseQuote, type ParsedQuote } from "@/deals/parse-quote";
import type { DealStatus, DealWithPrices } from "@/types/db";

interface StarredMessage {
  mailbox?: string;
  from: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  text: string;
}

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
  // Publishers price these alongside the niches, in the same list, so they
  // belong in the same suggestions: a rate card that says "Link insertion 150"
  // is quoting a product, not a subject.
  "Link insertion",
  "Niche edit",
  "Homepage link",
  "Footer text link",
  "Banner",
  "Press release",
];

/** Options for the fields that have a fixed set of answers. */
const OPTIONS = {
  currency: ["USD", "GBP", "EUR", "INR", "PKR", "AUD", "CAD", "AED", "SGD"],
  linkType: ["dofollow", "nofollow", "sponsored", "ugc", "mixed"],
  placement: [
    "guest post",
    "niche edit",
    "link insertion",
    "homepage",
    "press release",
    "banner",
    "footer link",
    "sidebar link",
  ],
  contentBy: ["us", "publisher", "either"],
  paymentMethod: [
    "PayPal",
    "Wise",
    "Payoneer",
    "Bank transfer",
    "Stripe",
    "Revolut",
    "Crypto",
  ],
  paymentTerms: [
    "100% advance",
    "50% advance",
    "30% advance",
    "Payment after publication",
    "Net 15",
    "Net 30",
    "Net 45",
  ],
};

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
  const [starred, setStarred] = useState<StarredMessage[] | null>(null);
  const [loadingStarred, setLoadingStarred] = useState(false);

  /**
   * Pulls in whatever the user has starred in Gmail.
   *
   * A quote often predates the mailbox being connected, or sits behind the
   * poller's checkpoint, so it is in no thread this app can offer. Starring it
   * is what the user already does by hand; this makes that reachable.
   */
  async function loadStarred() {
    setLoadingStarred(true);
    setReadNote(null);
    try {
      const response = await fetch("/api/mailboxes/starred?limit=5");
      const body = await response.text();
      const payload = JSON.parse(body) as {
        results?: { mailbox: string; error: string | null; messages: StarredMessage[] }[];
      };

      const messages = (payload.results ?? []).flatMap((entry) =>
        entry.messages.map((message) => ({ ...message, mailbox: entry.mailbox })),
      );
      const failed = (payload.results ?? []).filter((entry) => entry.error);

      setStarred(messages);
      if (messages.length === 0) {
        setReadNote(
          failed.length > 0
            ? `No starred mail could be read. ${failed
                .map((entry) => `${entry.mailbox}: ${entry.error}`)
                .join(" · ")}`
            : "Nothing starred in any connected mailbox. Star a publisher's reply in Gmail and try again.",
        );
      }
    } catch (err) {
      setReadNote(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStarred(false);
    }
  }

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
          <button
            className="btn-secondary px-2.5 py-1.5 text-xs"
            type="button"
            disabled={loadingStarred}
            onClick={loadStarred}
          >
            {loadingStarred ? "Checking mailboxes…" : "Load starred emails"}
          </button>
        </div>

        {starred && starred.length > 0 && (
          <ul className="mt-3 space-y-1">
            {starred.map((message, index) => (
              <li
                key={`${message.mailbox}-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-line)] px-3 py-2"
              >
                <span className="min-w-0 text-xs">
                  <span className="font-medium">{message.from}</span>
                  <span className="text-[var(--color-muted)]">
                    {" "}
                    — {message.subject ?? "(no subject)"} ·{" "}
                    {new Date(message.receivedAt).toLocaleDateString()} ·{" "}
                    {message.mailbox}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button
                    className="hint hover:underline"
                    type="button"
                    onClick={() => setPaste(message.text)}
                  >
                    Show text
                  </button>
                  <button
                    className="text-xs font-medium text-[var(--color-brand)] hover:underline"
                    type="button"
                    onClick={() => applyQuote(message.text)}
                  >
                    Use this
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

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
        <OptionField
          label="Currency"
          value={currency}
          onChange={(value) => setCurrency(value.toUpperCase())}
          options={OPTIONS.currency}
        />
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
        <OptionField
          label="Link type"
          value={linkType}
          onChange={setLinkType}
          options={OPTIONS.linkType}
        />
        <OptionField
          label="Placement"
          value={placement}
          onChange={setPlacement}
          options={OPTIONS.placement}
        />
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
        <OptionField
          label="Content by"
          value={contentBy}
          onChange={setContentBy}
          options={OPTIONS.contentBy}
        />
        <OptionField
          label="Payment method"
          value={paymentMethod}
          onChange={setPaymentMethod}
          options={OPTIONS.paymentMethod}
        />
        <OptionField
          label="Payment terms"
          value={paymentTerms}
          onChange={setPaymentTerms}
          options={OPTIONS.paymentTerms}
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

/**
 * A dropdown that cannot lose an answer it does not know.
 *
 * Publishers quote things no fixed list anticipates, and the parser reads their
 * wording verbatim. So a value that is not one of the options is added as one,
 * and "Other…" turns the control into a text box rather than forcing a choice.
 */
function OptionField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  const id = `field-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const [custom, setCustom] = useState(false);

  const known = options.some(
    (option) => option.toLowerCase() === value.trim().toLowerCase(),
  );
  const all = value && !known ? [value, ...options] : options;

  if (custom) {
    return (
      <div>
        <label className="label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="input"
          autoFocus
          value={value}
          placeholder="Type it as they wrote it"
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setCustom(false)}
        />
      </div>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="input"
        value={value}
        onChange={(e) => {
          if (e.target.value === "__other__") {
            setCustom(true);
            onChange("");
            return;
          }
          onChange(e.target.value);
        }}
      >
        <option value="">—</option>
        {all.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        <option value="__other__">Other…</option>
      </select>
    </div>
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
