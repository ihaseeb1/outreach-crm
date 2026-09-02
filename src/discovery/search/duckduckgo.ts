import { search, SafeSearchType } from "duck-duck-scrape";

import type { GeoParams } from "@/discovery/geo";
import { toHit, type SearchHit, type SearchProvider } from "@/discovery/search/provider";

/**
 * DuckDuckGo — the default engine. Keyless, no host to run, no account. It is
 * the free tier's baseline: coverage is narrower than a paid API and DDG
 * rate-limits scraping, so the router throttles and falls back to other
 * engines when configured.
 *
 * DDG's HTML endpoint takes a region code (e.g. "uk-en", "us-en"); we map our
 * geo params onto it best-effort, and default to no region (worldwide).
 */

/** hl/gl → DDG "kl" region code (e.g. "us-en", "uk-en", "de-de"). */
function ddgRegion(geo: GeoParams): string | undefined {
  if (!geo.gl) return undefined;
  const gl = geo.gl.toLowerCase();
  const hl = (geo.hl ?? "en").toLowerCase().split("-")[0];
  // DDG spells the UK "uk", not the ISO "gb".
  const country = gl === "gb" ? "uk" : gl;
  return `${country}-${hl}`;
}

/** DDG keeps <b> bold tags in titles/descriptions; strip them. */
function stripTags(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || null;
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo";
  readonly enabled = true;

  async search(query: string, geo: GeoParams, limit: number): Promise<SearchHit[]> {
    try {
      const region = ddgRegion(geo);
      const results = await search(query, {
        safeSearch: SafeSearchType.OFF,
        ...(region ? { region } : {}),
      });
      if (results.noResults || !Array.isArray(results.results)) return [];

      const hits: SearchHit[] = [];
      let position = 0;
      for (const r of results.results) {
        position += 1;
        const hit = toHit(
          { url: r.url, title: stripTags(r.title), description: stripTags(r.description) },
          position,
          this.name,
        );
        if (hit) hits.push(hit);
        if (hits.length >= limit) break;
      }
      return hits;
    } catch {
      // A rate-limit or transient network error: let the router fall back.
      return [];
    }
  }
}
