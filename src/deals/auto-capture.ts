/**
 * Turns a parsed publisher quote into deal fields, and merges it into whatever
 * deal already exists — without ever stepping on something a human typed.
 *
 * This is the pure half of "read every reply and file the numbers on the deal".
 * `parseQuote` already reads a rate card out of prose (prices per niche, TAT,
 * DA/DR, traffic, spam score, word count, max links, content-by, link type,
 * placement, payment method + terms); this module maps that onto the `deals`
 * columns and decides what is safe to write.
 *
 * The one rule that makes auto-capture trustworthy: **it only fills blanks.** A
 * value already on the deal is a value a person either typed or accepted, and it
 * is never overwritten by a later parse — exactly the "first read wins" the deal
 * form uses when you click "Use this". A wrong read stays visible (the evidence
 * line it came from is written into the notes) rather than silently changing a
 * number underneath you.
 *
 * No network, no database, no model. Given a quote and the deal as it stands, it
 * returns the columns to update, the new niche prices to add, and the notes
 * block to write. The caller does the reading and writing.
 */

import type { ParsedQuote, ParsedPrice } from "@/deals/parse-quote";
import { countFound } from "@/deals/parse-quote";

/** The scalar columns on `deals` that a parsed quote can fill. */
export interface DealCaptureFields {
  link_type: string | null;
  placement_type: string | null;
  tat_days: number | null;
  da: number | null;
  dr: number | null;
  monthly_traffic: number | null;
  spam_score: number | null;
  word_count: number | null;
  content_by: string | null;
  max_links: number | null;
  payment_terms: string | null;
  payment_method: string | null;
}

export interface CapturePrice {
  niche: string;
  price: number;
  currency: string;
}

/**
 * Everything the DB layer needs to write, computed from the quote and the deal
 * as it currently stands. Empty when there is nothing new to save.
 */
export interface CapturePlan {
  /** Scalar columns to `update` — only the ones that were blank. */
  fields: Partial<DealCaptureFields>;
  /** Currency to stamp on a brand-new deal (never changes an existing one). */
  currency: string | null;
  /** Niche prices not already on the deal. Existing niches are left untouched. */
  newPrices: CapturePrice[];
  /** Human-readable field names that were filled, for the activity log. */
  filledKeys: string[];
  /** Field name → the line of the email it was read from. */
  evidence: Record<string, string>;
  /** Nothing recognisable, or nothing left to add. */
  isEmpty: boolean;
}

/** How a deal looks to the merge — only the columns it may fill, plus niches held. */
export interface DealSnapshot extends Partial<DealCaptureFields> {
  /** Niches already priced on the deal, so they are never re-added or changed. */
  existingNiches?: string[];
}

const SCALAR_KEYS: (keyof DealCaptureFields)[] = [
  "link_type",
  "placement_type",
  "tat_days",
  "da",
  "dr",
  "monthly_traffic",
  "spam_score",
  "word_count",
  "content_by",
  "max_links",
  "payment_terms",
  "payment_method",
];

/** Quote field → deal column, so the mapping lives in exactly one place. */
function quoteToFields(quote: ParsedQuote): Partial<DealCaptureFields> {
  return {
    link_type: quote.linkType,
    placement_type: quote.placementType,
    tat_days: quote.tatDays,
    da: quote.da,
    dr: quote.dr,
    monthly_traffic: quote.monthlyTraffic,
    spam_score: quote.spamScore,
    word_count: quote.wordCount,
    content_by: quote.contentBy,
    max_links: quote.maxLinks,
    payment_terms: quote.paymentTerms,
    payment_method: quote.paymentMethod,
  };
}

/** A deal column that carries no value yet — the only kind auto-capture writes. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Works out what a reply adds to a deal.
 *
 * `existing` is the deal as it stands (pass an empty object for a deal that does
 * not exist yet, so every parsed value counts as new). Only blank columns and
 * unseen niches come back; a value already present is left exactly as it is.
 */
export function planCapture(
  quote: ParsedQuote,
  existing: DealSnapshot = {},
): CapturePlan {
  const plan: CapturePlan = {
    fields: {},
    currency: null,
    newPrices: [],
    filledKeys: [],
    evidence: {},
    isEmpty: true,
  };

  if (countFound(quote) === 0) return plan;

  const incoming = quoteToFields(quote);

  for (const key of SCALAR_KEYS) {
    const value = incoming[key];
    if (isBlank(value)) continue;
    if (!isBlank(existing[key])) continue; // never overwrite
    // TS cannot see that incoming[key] and fields[key] share a type per key.
    (plan.fields as Record<string, unknown>)[key] = value;
    plan.filledKeys.push(key);
    const line = quote.evidence[key];
    if (line) plan.evidence[key] = line;
  }

  const held = new Set(
    (existing.existingNiches ?? []).map((niche) => niche.trim().toLowerCase()),
  );
  const currency = quote.currency ?? "USD";
  const seen = new Set<string>();

  for (const price of quote.prices as ParsedPrice[]) {
    const key = price.niche.trim().toLowerCase();
    if (!key || held.has(key) || seen.has(key)) continue;
    seen.add(key);
    plan.newPrices.push({ niche: price.niche.trim(), price: price.price, currency });
    const line = quote.evidence[`price:${price.niche}`];
    if (line) plan.evidence[`price:${price.niche}`] = line;
  }

  plan.currency = quote.currency ?? null;
  plan.isEmpty =
    plan.filledKeys.length === 0 && plan.newPrices.length === 0;

  return plan;
}

// ---------------------------------------------------------------------------
// Notes block — the human-readable record of what was read, and from where.
// ---------------------------------------------------------------------------

const NOTE_START = "── Auto-captured from reply";
// One delimited block, replaced wholesale on each capture so re-reading a thread
// never stacks up duplicate blocks. Everything the user typed sits outside it
// and is never touched.
const BLOCK_RE = /\n*── Auto-captured from reply[\s\S]*?── end auto-capture ──/g;

function label(key: string): string {
  const map: Record<string, string> = {
    link_type: "Link type",
    placement_type: "Placement",
    tat_days: "Turnaround (days)",
    da: "DA",
    dr: "DR",
    monthly_traffic: "Monthly traffic",
    spam_score: "Spam score",
    word_count: "Word count",
    content_by: "Content by",
    max_links: "Max links",
    payment_terms: "Payment terms",
    payment_method: "Payment method",
  };
  return map[key] ?? key;
}

/**
 * Builds the "Auto-captured from reply" block: every price and every filled
 * field, each with the line of the email it was read from so a wrong read is
 * checkable at a glance. Returns "" when nothing was captured.
 */
export function buildCaptureNote(
  plan: CapturePlan,
  quote: ParsedQuote,
  when: Date = new Date(),
): string {
  if (plan.isEmpty) return "";

  const date = when.toISOString().slice(0, 10);
  const lines: string[] = [`${NOTE_START} (${date}) ──`];

  if (plan.newPrices.length > 0) {
    const currency = quote.currency ?? "";
    lines.push(
      "Prices: " +
        plan.newPrices
          .map((p) => `${p.niche} ${currency}${p.price}`.trim())
          .join(", "),
    );
  }

  for (const key of plan.filledKeys) {
    const value = (plan.fields as Record<string, unknown>)[key];
    const evidence = plan.evidence[key];
    lines.push(`${label(key)}: ${value}${evidence ? `  ·  “${evidence}”` : ""}`);
  }

  lines.push(
    "(auto-filled blank fields only — check these against the email)",
  );
  lines.push("── end auto-capture ──");
  return lines.join("\n");
}

/**
 * Splices the capture block into the deal's notes.
 *
 * The user's own notes are whatever sits outside the delimited block; they are
 * preserved untouched, and a previous auto-block is replaced rather than
 * appended so the notes never grow a stack of them.
 */
export function mergeNote(existingNotes: string | null, block: string): string {
  const base = (existingNotes ?? "").replace(BLOCK_RE, "").trimEnd();
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------
// Setting — on by default, turned off per workspace.
// ---------------------------------------------------------------------------

/**
 * Whether replies should be auto-captured for this workspace. On unless the
 * workspace has explicitly set it off, so a workspace that has never touched the
 * setting gets the feature.
 */
export function autoCaptureEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return true;
  const value = (settings as Record<string, unknown>).deal_capture;
  if (value === false || value === "off") return false;
  if (value && typeof value === "object") {
    return (value as { enabled?: unknown }).enabled !== false;
  }
  return true;
}
