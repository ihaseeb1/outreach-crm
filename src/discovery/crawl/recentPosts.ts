import type { SupabaseClient } from "@supabase/supabase-js";

import { crawlDelayMs, fetchRobots, isAllowed } from "@/scraper/robots";
import { fetchCached } from "@/discovery/crawl/fetcher";
import { parseSitemap, recentFromSitemap } from "@/discovery/crawl/sitemap";
import { parseFeed, recentFromFeed } from "@/discovery/crawl/rss";

/**
 * Finds a publisher's recent posts within the active-author window, cheaply and
 * politely: it reads the sitemap (or sitemap index) first, falling back to an
 * RSS/Atom feed, rather than crawling the whole site. Reuses the existing
 * robots policy and the cached fetcher. Never throws.
 */

export interface RecentPost {
  url: string;
  publishedAt: string | null;
  title: string | null;
}

const SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/post-sitemap.xml",
  "/sitemap/sitemap-index.xml",
];

const FEED_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];

const MAX_CHILD_SITEMAPS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function findRecentPosts(
  supabase: SupabaseClient,
  origin: string,
  options: { windowDays: number; limit?: number; respectRobots?: boolean; now?: Date } = { windowDays: 30 },
): Promise<RecentPost[]> {
  const limit = options.limit ?? 15;
  const respectRobots = options.respectRobots ?? true;
  const now = options.now ?? new Date();

  let robots;
  try {
    robots = await fetchRobots(origin);
  } catch {
    robots = null;
  }
  const delay = robots ? crawlDelayMs(robots) : 1500;
  const allowed = (url: string) => {
    if (!respectRobots || !robots) return true;
    try {
      return isAllowed(robots, new URL(url).pathname);
    } catch {
      return false;
    }
  };

  // --- Sitemaps first ---
  const fromSitemap = await trySitemaps(supabase, origin, allowed, delay, options.windowDays, limit, now);
  if (fromSitemap.length > 0) return fromSitemap.slice(0, limit);

  // --- RSS / Atom fallback ---
  for (const path of FEED_PATHS) {
    const url = `${origin}${path}`;
    if (!allowed(url)) continue;
    const outcome = await fetchCached(supabase, url);
    await sleep(delay);
    if (!outcome.ok) continue;
    const items = recentFromFeed(parseFeed(outcome.page.html), options.windowDays, now);
    if (items.length > 0) {
      return items.slice(0, limit).map((i) => ({ url: i.url, publishedAt: i.publishedAt, title: i.title }));
    }
  }

  return [];
}

async function trySitemaps(
  supabase: SupabaseClient,
  origin: string,
  allowed: (url: string) => boolean,
  delay: number,
  windowDays: number,
  limit: number,
  now: Date,
): Promise<RecentPost[]> {
  for (const path of SITEMAP_PATHS) {
    const url = `${origin}${path}`;
    if (!allowed(url)) continue;
    const outcome = await fetchCached(supabase, url);
    await sleep(delay);
    if (!outcome.ok) continue;

    const parsed = parseSitemap(outcome.page.html);

    // A urlset directly: use its recent entries.
    if (parsed.urls.length > 0) {
      const recent = recentFromSitemap(parsed.urls, windowDays, now);
      if (recent.length > 0) {
        return recent.map((u) => ({ url: u.loc, publishedAt: u.lastmod, title: null }));
      }
    }

    // A sitemap index: fetch the most promising child sitemaps.
    if (parsed.sitemaps.length > 0) {
      const children = prioritizeChildren(parsed.sitemaps).slice(0, MAX_CHILD_SITEMAPS);
      const collected: RecentPost[] = [];
      for (const child of children) {
        if (!allowed(child)) continue;
        const childOutcome = await fetchCached(supabase, child);
        await sleep(delay);
        if (!childOutcome.ok) continue;
        const childParsed = parseSitemap(childOutcome.page.html);
        const recent = recentFromSitemap(childParsed.urls, windowDays, now);
        for (const u of recent) collected.push({ url: u.loc, publishedAt: u.lastmod, title: null });
        if (collected.length >= limit) break;
      }
      if (collected.length > 0) {
        return collected.sort(
          (a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""),
        );
      }
    }
  }
  return [];
}

/** Post/blog sitemaps before category/page/tag ones. */
function prioritizeChildren(sitemaps: string[]): string[] {
  const score = (s: string) => {
    const l = s.toLowerCase();
    if (l.includes("post")) return 0;
    if (l.includes("blog") || l.includes("article")) return 1;
    if (l.includes("page") || l.includes("category") || l.includes("tag")) return 9;
    return 5;
  };
  return [...sitemaps].sort((a, b) => score(a) - score(b));
}
