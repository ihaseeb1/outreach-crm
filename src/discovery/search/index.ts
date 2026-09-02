import pLimit from "p-limit";

import { env } from "@/lib/env";
import type { GeoParams } from "@/discovery/geo";
import type { SearchHit, SearchProvider } from "@/discovery/search/provider";
import { DuckDuckGoProvider } from "@/discovery/search/duckduckgo";
import { SearxngProvider } from "@/discovery/search/searxng";
import { GoogleCseProvider } from "@/discovery/search/googleCse";

/**
 * The multi-engine router — the only search surface the pipeline uses.
 *
 * It reads SEARCH_ENGINES, builds the enabled providers, and spreads a run's
 * queries across them round-robin so no single engine gets hammered into a
 * rate-limit. If the chosen engine returns nothing (a transient block), it
 * falls back through the other enabled engines in order. Results are deduped
 * across engines by URL, keeping the best (lowest) position seen.
 */

const ALL: Record<string, () => SearchProvider> = {
  duckduckgo: () => new DuckDuckGoProvider(),
  searxng: () => new SearxngProvider(),
  google_cse: () => new GoogleCseProvider(),
};

/** The enabled providers, in the configured order. Always ≥1 (DuckDuckGo). */
export function getProviders(): SearchProvider[] {
  const configured = env.searchEngines();
  const providers: SearchProvider[] = [];
  for (const name of configured) {
    const make = ALL[name];
    if (make) {
      const provider = make();
      if (provider.enabled) providers.push(provider);
    }
  }
  // DuckDuckGo is the keyless default — never leave the router with nothing.
  if (providers.length === 0) providers.push(new DuckDuckGoProvider());
  return providers;
}

export interface RunSearchOptions {
  geo?: GeoParams;
  /** Max results kept per query (across engines). */
  perQueryLimit?: number;
  /** Concurrent queries in flight. Kept low to stay polite. */
  concurrency?: number;
  /** Delay between a query starting, per engine, in ms. */
  perQueryDelayMs?: number;
  providers?: SearchProvider[];
  /** Called after each query completes, for progress streaming. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface QueryResult {
  query: string;
  hits: SearchHit[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one query against the round-robin-selected engine, falling back to the
 * others on an empty result.
 */
export async function searchOne(
  query: string,
  primary: SearchProvider,
  fallbacks: SearchProvider[],
  geo: GeoParams,
  limit: number,
): Promise<SearchHit[]> {
  const tried = new Set<string>();
  const order = [primary, ...fallbacks];
  for (const provider of order) {
    if (tried.has(provider.name)) continue;
    tried.add(provider.name);
    const hits = await provider.search(query, geo, limit);
    if (hits.length > 0) return hits;
  }
  return [];
}

/**
 * Runs the whole query list. Queries are assigned to engines round-robin; each
 * query still falls back through the rest on failure. Deduping is left to the
 * caller (it reduces to domains), but per-query hits are deduped by URL here.
 */
export async function runSearch(
  queries: string[],
  options: RunSearchOptions = {},
): Promise<QueryResult[]> {
  const providers = options.providers ?? getProviders();
  const geo = options.geo ?? {};
  const limit = options.perQueryLimit ?? 20;
  const delay = options.perQueryDelayMs ?? env.perHostDelayMs();
  const concurrency = Math.max(1, options.concurrency ?? 2);

  const limiter = pLimit(concurrency);
  let done = 0;
  const total = queries.length;

  const tasks = queries.map((query, index) =>
    limiter(async () => {
      // Round-robin the primary engine; the rest are fallbacks in order.
      const primaryIdx = index % providers.length;
      const primary = providers[primaryIdx]!;
      const fallbacks = providers.filter((_, i) => i !== primaryIdx);

      // Space queries out so DDG's rate-limiter doesn't 202 us. Each task
      // waits before its fetch; with concurrency 1 that gives a real gap
      // between every query, scaled down as concurrency rises.
      if (delay > 0 && index > 0) await sleep(Math.round(delay / concurrency));
      const hits = dedupeByUrl(await searchOne(query, primary, fallbacks, geo, limit));

      done += 1;
      await options.onProgress?.(done, total);
      return { query, hits };
    }),
  );

  return Promise.all(tasks);
}

function dedupeByUrl(hits: SearchHit[]): SearchHit[] {
  const byUrl = new Map<string, SearchHit>();
  for (const hit of hits) {
    const existing = byUrl.get(hit.url);
    if (!existing || hit.position < existing.position) byUrl.set(hit.url, hit);
  }
  return [...byUrl.values()];
}
