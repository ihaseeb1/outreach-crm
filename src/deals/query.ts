import type { SupabaseClient } from "@supabase/supabase-js";

import type { DealWithPrices } from "@/types/db";

/**
 * Shared deal loading + filtering, used by the deals table, the exports, and the
 * external API so all three always agree on what a filter means.
 *
 * Niche and price filters are applied in memory: Postgres can filter a parent by
 * a child row, but not while still returning every child, and a rate card is
 * useless with its other niches stripped out.
 */

export interface DealFilters {
  status?: string;
  domain?: string;
  niche?: string;
  minPrice?: number;
  maxPrice?: number;
  maxTat?: number;
  minDr?: number;
  /** Only deals closed on this mailbox. */
  mailboxId?: string;
  limit?: number;
}

/**
 * `conversations(mailbox_id)` comes along for the ride.
 *
 * Which of the seven addresses a publisher was won on is not recorded on the
 * deal — but the conversation the deal was logged from knows, and a deal
 * without one falls back to the last thing we sent that contact. Reading it
 * here rather than adding a column means no migration, and no second source of
 * truth to drift.
 */
const SELECT = "*, deal_prices(*), conversations(mailbox_id)";

export async function loadDeals(
  supabase: SupabaseClient,
  workspaceId: string,
  filters: DealFilters = {},
): Promise<DealWithPrices[]> {
  let query = supabase
    .from("deals")
    .select(SELECT)
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(Math.min(filters.limit ?? 1000, 5000));

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.domain) query = query.ilike("domain", `%${filters.domain}%`);
  if (filters.maxTat !== undefined) query = query.lte("tat_days", filters.maxTat);
  if (filters.minDr !== undefined) query = query.gte("dr", filters.minDr);

  const { data } = await query;
  const deals = (data ?? []) as unknown as DealWithPrices[];

  return deals.filter((deal) => matchesPriceFilters(deal, filters));
}

export function matchesPriceFilters(
  deal: DealWithPrices,
  filters: DealFilters,
): boolean {
  const { niche, minPrice, maxPrice } = filters;
  if (!niche && minPrice === undefined && maxPrice === undefined) return true;

  const prices = deal.deal_prices ?? [];
  const relevant = niche
    ? prices.filter((price) =>
        price.niche.toLowerCase().includes(niche.toLowerCase()),
      )
    : prices;

  if (relevant.length === 0) return false;

  return relevant.some((price) => {
    const value = Number(price.price);
    if (minPrice !== undefined && value < minPrice) return false;
    if (maxPrice !== undefined && value > maxPrice) return false;
    return true;
  });
}

export function parseDealFilters(params: URLSearchParams): DealFilters {
  const number = (key: string): number | undefined => {
    const raw = params.get(key);
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  return {
    status: params.get("status") || undefined,
    domain: params.get("domain") || undefined,
    niche: params.get("niche") || undefined,
    minPrice: number("min_price"),
    maxPrice: number("max_price"),
    maxTat: number("max_tat"),
    minDr: number("min_dr"),
    mailboxId: params.get("mailbox") || undefined,
    limit: number("limit"),
  };
}

/**
 * Applies the mailbox filter.
 *
 * Separate from `loadDeals` on purpose: which mailbox a deal belongs to is not
 * a column on `deals`, so it cannot be a `where` clause — it is resolved from
 * the conversation, and for hand-entered deals from the message history. Doing
 * it here means the resolution runs once and both the filtering and the column
 * on screen read the same answer.
 */
export function filterByMailbox(
  deals: DealWithPrices[],
  mailboxByDeal: Map<string, string>,
  mailboxId: string | undefined,
): DealWithPrices[] {
  if (!mailboxId) return deals;
  if (mailboxId === "none") {
    return deals.filter((deal) => !mailboxByDeal.has(deal.id));
  }
  return deals.filter((deal) => mailboxByDeal.get(deal.id) === mailboxId);
}

/**
 * Which mailbox each deal was closed on.
 *
 * Two sources, in order of confidence: the conversation the deal was logged
 * from, and — for a deal typed in by hand, which has no conversation — the last
 * message actually exchanged with that contact. The second is a fair answer to
 * the question being asked ("which of my addresses is this publisher talking
 * to?") and is much better than a dash.
 */
export async function dealMailboxMap(
  supabase: SupabaseClient,
  deals: DealWithPrices[],
): Promise<Map<string, string>> {
  const byDeal = new Map<string, string>();
  const unresolved: string[] = [];

  for (const deal of deals) {
    const mailboxId = conversationMailboxId(deal);
    if (mailboxId) byDeal.set(deal.id, mailboxId);
    else if (deal.contact_id) unresolved.push(deal.contact_id);
  }

  if (unresolved.length > 0) {
    const { data } = await supabase
      .from("messages")
      .select("contact_id, mailbox_id, created_at")
      .in("contact_id", [...new Set(unresolved)])
      .not("mailbox_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(5000);

    const byContact = new Map<string, string>();
    for (const row of (data ?? []) as {
      contact_id: string | null;
      mailbox_id: string | null;
    }[]) {
      // Ordered newest first, so the first one seen for a contact wins.
      if (row.contact_id && row.mailbox_id && !byContact.has(row.contact_id)) {
        byContact.set(row.contact_id, row.mailbox_id);
      }
    }

    for (const deal of deals) {
      if (byDeal.has(deal.id) || !deal.contact_id) continue;
      const mailboxId = byContact.get(deal.contact_id);
      if (mailboxId) byDeal.set(deal.id, mailboxId);
    }
  }

  return byDeal;
}

/**
 * PostgREST returns an embedded to-one relation as an object, but as an array
 * when it cannot prove the relationship is unique. Both shapes appear here
 * depending on how the query is written, so both are read.
 */
function conversationMailboxId(deal: DealWithPrices): string | null {
  const embedded = (deal as DealWithPrices & {
    conversations?: { mailbox_id: string | null } | { mailbox_id: string | null }[] | null;
  }).conversations;

  if (!embedded) return null;
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  return row?.mailbox_id ?? null;
}

/** contact_id -> email, for exports and the API. */
export async function contactEmailMap(
  supabase: SupabaseClient,
  deals: DealWithPrices[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      deals
        .map((deal) => deal.contact_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return new Map();

  const { data } = await supabase.from("contacts").select("id, email").in("id", ids);
  return new Map(
    ((data ?? []) as { id: string; email: string }[]).map((row) => [
      row.id,
      row.email,
    ]),
  );
}
