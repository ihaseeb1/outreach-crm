import { env } from "@/lib/env";
import type { GeoParams } from "@/discovery/geo";
import { toHit, type SearchHit, type SearchProvider } from "@/discovery/search/provider";

/**
 * SearXNG — an optional upgrade. The user self-hosts a SearXNG instance (a
 * couple of Docker commands) and points SEARXNG_URL at it. SearXNG aggregates
 * Google, Bing and others behind one keyless JSON API, giving much wider
 * coverage than DuckDuckGo alone, still at zero cost.
 *
 * Disabled automatically when SEARXNG_URL is unset.
 */
export class SearxngProvider implements SearchProvider {
  readonly name = "searxng";
  readonly enabled: boolean;
  private readonly base: string;

  constructor() {
    this.base = env.searxngUrl();
    this.enabled = this.base.length > 0;
  }

  async search(query: string, geo: GeoParams, limit: number): Promise<SearchHit[]> {
    if (!this.enabled) return [];
    try {
      const url = new URL(`${this.base}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("safesearch", "0");
      if (geo.hl) url.searchParams.set("language", geo.hl);

      const response = await fetch(url, {
        headers: {
          "user-agent": env.crawlerUserAgent(),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return [];

      const data = (await response.json()) as {
        results?: { url?: string; title?: string; content?: string }[];
      };
      const rows = Array.isArray(data.results) ? data.results : [];

      const hits: SearchHit[] = [];
      let position = 0;
      for (const r of rows) {
        position += 1;
        const hit = toHit(
          { url: r.url ?? "", title: r.title ?? null, description: r.content ?? null },
          position,
          this.name,
        );
        if (hit) hits.push(hit);
        if (hits.length >= limit) break;
      }
      return hits;
    } catch {
      return [];
    }
  }
}
