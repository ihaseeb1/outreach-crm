import { XMLParser } from "fast-xml-parser";

/**
 * Minimal sitemap parsing. Handles both a `<urlset>` (pages) and a
 * `<sitemapindex>` (links to more sitemaps), pulling `<loc>` and the optional
 * `<lastmod>` so recent posts can be found without crawling the whole site.
 *
 * Pure and total — malformed XML yields empty lists, never a throw.
 */

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
}

export interface ParsedSitemap {
  /** Page URLs from a <urlset>. */
  urls: SitemapUrl[];
  /** Child sitemap URLs from a <sitemapindex>. */
  sitemaps: string[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
});

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

export function parseSitemap(xml: string): ParsedSitemap {
  const result: ParsedSitemap = { urls: [], sitemaps: [] };
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return result;
  }

  const urlset = doc.urlset as { url?: unknown } | undefined;
  if (urlset) {
    for (const entry of toArray(urlset.url as Record<string, unknown>[])) {
      const loc = text(entry.loc);
      if (loc) result.urls.push({ loc, lastmod: text(entry.lastmod) });
    }
  }

  const index = doc.sitemapindex as { sitemap?: unknown } | undefined;
  if (index) {
    for (const entry of toArray(index.sitemap as Record<string, unknown>[])) {
      const loc = text(entry.loc);
      if (loc) result.sitemaps.push(loc);
    }
  }

  return result;
}

/** Post URLs whose lastmod is within `windowDays`, newest first. */
export function recentFromSitemap(
  urls: SitemapUrl[],
  windowDays: number,
  now: Date = new Date(),
): SitemapUrl[] {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return urls
    .filter((u) => {
      if (!u.lastmod) return false;
      const t = Date.parse(u.lastmod);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.lastmod ?? "") - Date.parse(a.lastmod ?? ""));
}
