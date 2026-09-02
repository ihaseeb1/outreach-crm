import { XMLParser } from "fast-xml-parser";

/**
 * Minimal RSS + Atom feed parsing. Extracts each post's link, publish date and
 * title from either an RSS `<item>` or an Atom `<entry>`. Pure and total.
 */

export interface FeedItem {
  url: string;
  publishedAt: string | null;
  title: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
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
  if (value && typeof value === "object" && "#text" in (value as object)) {
    return text((value as { "#text": unknown })["#text"]);
  }
  return null;
}

/** Atom links can be an array with rel="alternate"; pick the best href. */
function atomLink(link: unknown): string | null {
  for (const l of toArray(link as Record<string, unknown>[])) {
    if (typeof l === "string") return l;
    const rel = text(l["@_rel"]);
    const href = text(l["@_href"]);
    if (href && (!rel || rel === "alternate")) return href;
  }
  const first = toArray(link as Record<string, unknown>[])[0];
  return first ? text((first as Record<string, unknown>)["@_href"]) : null;
}

export function parseFeed(xml: string): FeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const items: FeedItem[] = [];

  // RSS 2.0: rss > channel > item
  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  const channel = rss?.channel ?? (doc.channel as { item?: unknown } | undefined);
  if (channel) {
    for (const item of toArray((channel as { item?: unknown }).item as Record<string, unknown>[])) {
      const url = text(item.link);
      if (!url) continue;
      items.push({
        url,
        publishedAt: text(item.pubDate) ?? text(item["dc:date"]),
        title: text(item.title),
      });
    }
  }

  // Atom: feed > entry
  const feed = doc.feed as { entry?: unknown } | undefined;
  if (feed) {
    for (const entry of toArray(feed.entry as Record<string, unknown>[])) {
      const url = atomLink(entry.link);
      if (!url) continue;
      items.push({
        url,
        publishedAt: text(entry.updated) ?? text(entry.published),
        title: text(entry.title),
      });
    }
  }

  return items;
}

/** Feed items published within `windowDays`, newest first. */
export function recentFromFeed(
  items: FeedItem[],
  windowDays: number,
  now: Date = new Date(),
): FeedItem[] {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return items
    .filter((i) => {
      if (!i.publishedAt) return false;
      const t = Date.parse(i.publishedAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""));
}
