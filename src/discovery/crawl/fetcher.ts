import type { SupabaseClient } from "@supabase/supabase-js";

import { defaultScraper } from "@/scraper/static-scraper";
import type { FetchOutcome, Scraper } from "@/scraper/types";

/**
 * Polite fetch with a shared cache layer.
 *
 * All publisher crawling goes through here. The actual fetching reuses the
 * existing hardened scraper (SSRF guard, retries, size cap, content-type
 * check) — this only adds the `crawl_cache` table in front of it, so the same
 * post fetched by two runs (or re-fetched within the TTL) hits the cache
 * instead of the origin. Politeness (robots, per-host delay) is enforced by the
 * caller around this, exactly as runScrapeBatch does.
 *
 * Cache reads/writes are best-effort: a missing crawl_cache table (pre-0016)
 * simply means every fetch goes to the network.
 */

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface CachedFetchOptions {
  scraper?: Scraper;
  ttlSeconds?: number;
  /** Skip the cache read (still writes). */
  fresh?: boolean;
}

export async function fetchCached(
  supabase: SupabaseClient,
  url: string,
  options: CachedFetchOptions = {},
): Promise<FetchOutcome> {
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  if (!options.fresh) {
    const cached = await readCache(supabase, url, ttl);
    if (cached) return cached;
  }

  const scraper = options.scraper ?? defaultScraper;
  const outcome = await scraper.fetchPage(url);

  if (outcome.ok) {
    await writeCache(supabase, url, outcome.page.status, outcome.page.html, ttl);
  }
  return outcome;
}

async function readCache(
  supabase: SupabaseClient,
  url: string,
  ttl: number,
): Promise<FetchOutcome | null> {
  try {
    const { data, error } = await supabase
      .from("crawl_cache")
      .select("status_int, body, fetched_at, ttl_seconds")
      .eq("url", url)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as {
      status_int: number | null;
      body: string | null;
      fetched_at: string;
      ttl_seconds: number | null;
    };
    if (row.body == null) return null;

    const age = (Date.now() - Date.parse(row.fetched_at)) / 1000;
    const maxAge = row.ttl_seconds ?? ttl;
    if (age > maxAge) return null;

    return {
      ok: true,
      page: {
        url,
        finalUrl: url,
        status: row.status_int ?? 200,
        html: row.body,
        contentType: "text/html",
      },
    };
  } catch {
    return null;
  }
}

async function writeCache(
  supabase: SupabaseClient,
  url: string,
  status: number,
  body: string,
  ttl: number,
): Promise<void> {
  try {
    await supabase.from("crawl_cache").upsert(
      {
        url,
        status_int: status,
        body,
        fetched_at: new Date().toISOString(),
        ttl_seconds: ttl,
      },
      { onConflict: "url" },
    );
  } catch {
    // Cache is an optimization; never let it break a crawl.
  }
}
