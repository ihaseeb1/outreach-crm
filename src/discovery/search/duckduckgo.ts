import * as cheerio from "cheerio";

import type { GeoParams } from "@/discovery/geo";
import { toHit, type SearchHit, type SearchProvider } from "@/discovery/search/provider";

/**
 * DuckDuckGo — the default engine, keyless and hostless.
 *
 * We scrape DDG's server-rendered HTML endpoints (lite.duckduckgo.com/lite and
 * html.duckduckgo.com/html) directly rather than its JSON/VQD API: the JSON API
 * is aggressively blocked ("DDG detected an anomaly") while the HTML endpoints
 * return real results from both residential and datacenter IPs. Lite is the
 * primary (smallest, cleanest); the html endpoint is the fallback.
 *
 * DDG rate-limits rapid requests with a 202 and an empty body, so a 202/429 is
 * retried once after a short back-off. The router also spaces queries out.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** gl/hl → DDG "kl" region code (e.g. "us-en", "uk-en", "de-de"). */
function ddgRegion(geo: GeoParams): string | undefined {
  if (!geo.gl) return undefined;
  const gl = geo.gl.toLowerCase();
  const hl = (geo.hl ?? "en").toLowerCase().split("-")[0];
  const country = gl === "gb" ? "uk" : gl; // DDG spells the UK "uk", not "gb".
  return `${country}-${hl}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns a DDG redirect href (/l/?uddg=…) or a direct href into a clean URL. */
function resolveHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if ((u.protocol === "http:" || u.protocol === "https:") && !/duckduckgo\.com$/.test(u.hostname)) {
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}

interface Endpoint {
  url: string;
  linkSel: string;
  snippetSel: string;
}

const ENDPOINTS: Endpoint[] = [
  { url: "https://lite.duckduckgo.com/lite/", linkSel: "a.result-link", snippetSel: ".result-snippet" },
  { url: "https://html.duckduckgo.com/html/", linkSel: "a.result__a", snippetSel: ".result__snippet" },
];

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo";
  readonly enabled = true;

  async search(query: string, geo: GeoParams, limit: number): Promise<SearchHit[]> {
    const region = ddgRegion(geo);
    for (const endpoint of ENDPOINTS) {
      const hits = await this.fetchPaged(endpoint, query, region, limit);
      if (hits.length > 0) return hits;
    }
    return [];
  }

  /**
   * Walk successive result pages (DDG's `s` offset) on one endpoint until we
   * have `limit` unique URLs, a page adds nothing new, or the page cap is hit.
   * This is what lifts a query from ~20 results to the hundreds a big discovery
   * run needs — one page was the old ceiling. Pages are spaced to stay under
   * DDG's rate-limiter; a 202 (empty) simply ends the walk.
   */
  private async fetchPaged(
    endpoint: Endpoint,
    query: string,
    region: string | undefined,
    limit: number,
  ): Promise<SearchHit[]> {
    const MAX_PAGES = 12;
    const all = new Map<string, SearchHit>();
    let offset = 0;

    for (let page = 0; page < MAX_PAGES && all.size < limit; page += 1) {
      const pageHits = await this.fetchEndpoint(endpoint, query, region, offset);
      if (pageHits.length === 0) break;

      let added = 0;
      for (const hit of pageHits) {
        if (!all.has(hit.url)) {
          all.set(hit.url, hit);
          added += 1;
        }
      }
      // Offset advances by what the page actually returned; if nothing new came
      // back the endpoint is not paginating (or is out of results) — stop.
      if (added === 0) break;
      offset += pageHits.length;

      if (page < MAX_PAGES - 1 && all.size < limit) await sleep(1200);
    }

    // Re-number by discovery order so best_position still reflects rank.
    return [...all.values()]
      .slice(0, limit)
      .map((hit, i) => ({ ...hit, position: i + 1 }));
  }

  private async fetchEndpoint(
    endpoint: Endpoint,
    query: string,
    region: string | undefined,
    offset: number,
  ): Promise<SearchHit[]> {
    const body =
      `q=${encodeURIComponent(query)}` +
      (region ? `&kl=${region}` : "") +
      (offset > 0 ? `&s=${offset}&dc=${offset + 1}` : "");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            // DDG's HTML endpoints serve an empty 202 to non-browser UAs, so
            // this one path uses a browser UA rather than our polite bot UA.
            "user-agent": UA,
            "content-type": "application/x-www-form-urlencoded",
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
          },
          body,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });

        // 202 = rate-limited with an empty body. Back off and retry once.
        if (res.status === 202 || res.status === 429) {
          if (attempt < 2) {
            await sleep(1500 * attempt);
            continue;
          }
          return [];
        }
        if (!res.ok) return [];

        const html = await res.text();
        return this.parse(html, endpoint, this.name);
      } catch {
        if (attempt < 2) {
          await sleep(1000);
          continue;
        }
        return [];
      }
    }
    return [];
  }

  /** One result page, fully parsed (a page holds ~25–50 results). */
  private parse(html: string, endpoint: Endpoint, engine: string): SearchHit[] {
    const $ = cheerio.load(html);
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    let position = 0;

    $(endpoint.linkSel).each((_, el) => {
      const anchor = $(el);
      const url = resolveHref(anchor.attr("href"));
      if (!url || seen.has(url)) return;

      position += 1;
      const title = anchor.text().replace(/\s+/g, " ").trim() || null;
      // The snippet sits in a sibling cell (lite) or a sibling div (html).
      const container = anchor.closest("tr").length ? anchor.closest("table") : anchor.closest("div");
      const snippet =
        container.find(endpoint.snippetSel).first().text().replace(/\s+/g, " ").trim() || null;

      const hit = toHit({ url, title, description: snippet }, position, engine);
      if (hit) {
        seen.add(url);
        hits.push(hit);
      }
    });

    return hits;
  }
}
