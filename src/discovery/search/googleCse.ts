import { env } from "@/lib/env";
import type { GeoParams } from "@/discovery/geo";
import { toHit, type SearchHit, type SearchProvider } from "@/discovery/search/provider";

/**
 * Google Programmable Search (CSE) — an optional upgrade using Google's own
 * free tier (100 queries/day). Off unless both GOOGLE_CSE_KEY and
 * GOOGLE_CSE_CX are set. It returns the best raw quality of the three, but the
 * hard daily cap means the router treats it as a supplement, not the workhorse.
 *
 * The free tier returns at most 10 results per query.
 */
export class GoogleCseProvider implements SearchProvider {
  readonly name = "google_cse";
  readonly enabled: boolean;
  private readonly key: string;
  private readonly cx: string;

  constructor() {
    this.key = env.googleCseKey();
    this.cx = env.googleCseCx();
    this.enabled = this.key.length > 0 && this.cx.length > 0;
  }

  async search(query: string, geo: GeoParams, limit: number): Promise<SearchHit[]> {
    if (!this.enabled) return [];
    try {
      const url = new URL("https://www.googleapis.com/customsearch/v1");
      url.searchParams.set("key", this.key);
      url.searchParams.set("cx", this.cx);
      url.searchParams.set("q", query);
      url.searchParams.set("num", String(Math.min(10, Math.max(1, limit))));
      if (geo.gl) url.searchParams.set("gl", geo.gl);
      if (geo.hl) url.searchParams.set("hl", geo.hl);

      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return [];

      const data = (await response.json()) as {
        items?: { link?: string; title?: string; snippet?: string }[];
      };
      const rows = Array.isArray(data.items) ? data.items : [];

      const hits: SearchHit[] = [];
      let position = 0;
      for (const r of rows) {
        position += 1;
        const hit = toHit(
          { url: r.link ?? "", title: r.title ?? null, description: r.snippet ?? null },
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
