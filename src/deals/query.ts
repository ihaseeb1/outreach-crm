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
  limit?: number;
}

const SELECT = "*, deal_prices(*)";

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
    limit: number("limit"),
  };
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
