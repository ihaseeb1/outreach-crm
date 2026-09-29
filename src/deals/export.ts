import type { DealWithPrices } from "@/types/db";
import { CANONICAL_NICHES } from "@/deals/parse-quote";

/**
 * Turns deals into a flat grid for Excel.
 *
 * One row per publisher, with a column per price category in the fixed taxonomy
 * (see CANONICAL_NICHES) that appears across the export — which is how a rate
 * card is actually read and compared. Pure functions, so the shape is covered
 * by tests and reused by the XLSX, CSV, and clipboard-TSV paths.
 */

export const BASE_COLUMNS = [
  "Domain",
  "Status",
  "Contact email",
  "Closed on",
  "Link type",
  "Placement",
  "TAT (days)",
  "DA",
  "DR",
  "Monthly traffic",
  "Spam score",
  "Word count",
  "Content by",
  "Max links",
  "Currency",
  "Payment terms",
  "Payment method",
  "Notes",
  "Updated",
] as const;

export interface ExportGrid {
  headers: string[];
  rows: (string | number | null)[][];
}

export function nicheColumns(deals: DealWithPrices[]): string[] {
  // The column set is the fixed taxonomy, in taxonomy order — never the raw
  // phrases on the rows. Rows written before canonicalization (or typed by
  // hand) that do not match the taxonomy are simply not pivoted into columns;
  // their prices still live on the deal itself.
  const canonical = new Set<string>(CANONICAL_NICHES);
  const found = new Set<string>();
  for (const deal of deals) {
    for (const price of deal.deal_prices ?? []) {
      const niche = price.niche?.trim();
      if (niche && canonical.has(niche)) found.add(niche);
    }
  }

  return CANONICAL_NICHES.filter((niche) => found.has(niche));
}

export interface DealRowContext {
  /** contact_id -> email, so the export carries who quoted the price. */
  contactEmails?: Map<string, string>;
  /** deal_id -> the mailbox address the deal was closed on. */
  dealMailboxes?: Map<string, string>;
}

export function buildExportGrid(
  deals: DealWithPrices[],
  context: DealRowContext = {},
): ExportGrid {
  const niches = nicheColumns(deals);
  const headers = [...BASE_COLUMNS, ...niches.map((niche) => `${niche} price`)];

  const rows = deals.map((deal) => {
    const priceByNiche = new Map(
      (deal.deal_prices ?? []).map((price) => [
        price.niche.trim(),
        Number(price.price),
      ]),
    );

    const base: (string | number | null)[] = [
      deal.domain,
      deal.status,
      (deal.contact_id && context.contactEmails?.get(deal.contact_id)) ?? "",
      context.dealMailboxes?.get(deal.id) ?? "",
      deal.link_type ?? "",
      deal.placement_type ?? "",
      deal.tat_days ?? null,
      deal.da ?? null,
      deal.dr ?? null,
      deal.monthly_traffic ?? null,
      deal.spam_score ?? null,
      deal.word_count ?? null,
      deal.content_by ?? "",
      deal.max_links ?? null,
      deal.currency,
      deal.payment_terms ?? "",
      deal.payment_method ?? "",
      deal.notes ?? "",
      deal.updated_at ? deal.updated_at.slice(0, 10) : "",
    ];

    return [...base, ...niches.map((niche) => priceByNiche.get(niche) ?? null)];
  });

  return { headers, rows };
}

/** Tab-separated, for pasting straight into Excel or Sheets. */
export function gridToTsv(grid: ExportGrid): string {
  const escape = (value: string | number | null): string => {
    if (value === null || value === undefined) return "";
    // Tabs and newlines would break the column alignment on paste.
    return String(value).replace(/[\t\r\n]+/g, " ");
  };

  return [
    grid.headers.join("\t"),
    ...grid.rows.map((row) => row.map(escape).join("\t")),
  ].join("\n");
}

export function gridToCsv(grid: ExportGrid): string {
  const escape = (value: string | number | null): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    grid.headers.map(escape).join(","),
    ...grid.rows.map((row) => row.map(escape).join(",")),
  ].join("\r\n");
}

/** Shape returned by the read-only external API. */
export function toApiShape(
  deal: DealWithPrices,
  contactEmail?: string,
  extra: { mailboxEmail?: string | null } = {},
) {
  return {
    id: deal.id,
    domain: deal.domain,
    status: deal.status,
    contact_email: contactEmail ?? null,
    /** The address the deal was actually negotiated on. */
    mailbox_email: extra.mailboxEmail ?? null,
    link_type: deal.link_type,
    placement_type: deal.placement_type,
    tat_days: deal.tat_days,
    metrics: {
      da: deal.da,
      dr: deal.dr,
      monthly_traffic: deal.monthly_traffic,
      spam_score: deal.spam_score,
    },
    content: {
      word_count: deal.word_count,
      content_by: deal.content_by,
      max_links: deal.max_links,
    },
    payment: {
      currency: deal.currency,
      terms: deal.payment_terms,
      method: deal.payment_method,
    },
    prices: (deal.deal_prices ?? []).map((price) => ({
      niche: price.niche,
      price: Number(price.price),
      currency: price.currency,
    })),
    notes: deal.notes,
    created_at: deal.created_at,
    updated_at: deal.updated_at,
  };
}
