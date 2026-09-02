import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { logActivity } from "@/lib/activity";
import { crawlDelayMs, fetchRobots, isAllowed } from "@/scraper/robots";
import { resolveRespectRobots } from "@/scraper/safety";
import { fetchCached } from "@/discovery/crawl/fetcher";
import { findRecentPosts } from "@/discovery/crawl/recentPosts";
import { detectGuestPost } from "@/discovery/crawl/guestDetect";
import { destinationFromResolved, pickDestinationLink } from "@/discovery/crawl/bioLink";
import { freshnessScore, inferTopic } from "@/discovery/score/freshness";
import type { DiscoveredSite } from "@/types/db";

/**
 * Cron/worker batch for Feature 2. Claims discovered sites opted into
 * author-crawling, finds their recent posts, detects the guest ones, and
 * resolves each guest author's destination site into `active_authors`.
 *
 * Reuses the existing robots policy + SSRF-hardened fetcher via fetchCached.
 * One site is claimed per row with a conditional update (authors_crawled_at
 * null -> now), so overlapping ticks never double-crawl, and authors upsert on
 * (workspace_id, source_post_url, destination_domain) for idempotency.
 */

export interface PublisherCrawlResult {
  sitesProcessed: number;
  authorsFound: number;
}

const DETECT_THRESHOLD = 45;
const POSTS_PER_SITE = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runPublisherCrawlBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<PublisherCrawlResult> {
  const limit = options.limit ?? 2;
  const result: PublisherCrawlResult = { sitesProcessed: 0, authorsFound: 0 };
  const windowDays = env.activeAuthorWindowDays();

  let query = supabase
    .from("discovered_sites")
    .select("*")
    .eq("author_crawl", true)
    .is("authors_crawled_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data, error } = await query;
  if (error) return result; // pre-0017 or transient — nothing to do.

  const respectByWorkspace = new Map<string, boolean>();
  const respectFor = async (workspaceId: string): Promise<boolean> => {
    const cached = respectByWorkspace.get(workspaceId);
    if (cached !== undefined) return cached;
    const { data: ws } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle();
    const respect = resolveRespectRobots((ws as { settings?: Record<string, unknown> } | null)?.settings);
    respectByWorkspace.set(workspaceId, respect);
    return respect;
  };

  for (const site of (data ?? []) as DiscoveredSite[]) {
    // Claim: only the caller that stamps authors_crawled_at proceeds.
    const { data: claimed } = await supabase
      .from("discovered_sites")
      .update({ authors_crawled_at: new Date().toISOString() })
      .eq("id", site.id)
      .is("authors_crawled_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const respectRobots = await respectFor(site.workspace_id);
      const found = await crawlSite(supabase, site, windowDays, respectRobots);
      result.sitesProcessed += 1;
      result.authorsFound += found;
      await supabase
        .from("discovered_sites")
        .update({ authors_found: found })
        .eq("id", site.id);
    } catch (err) {
      await supabase
        .from("discovered_sites")
        .update({ meta: { ...site.meta, author_crawl_error: err instanceof Error ? err.message : String(err) } })
        .eq("id", site.id);
    }
  }

  return result;
}

async function crawlSite(
  supabase: SupabaseClient,
  site: DiscoveredSite,
  windowDays: number,
  respectRobots: boolean,
): Promise<number> {
  const sourceDomain = site.root_domain.toLowerCase().replace(/^www\./, "");
  const origin = `https://${sourceDomain}`;

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

  const posts = (await findRecentPosts(supabase, origin, { windowDays, limit: POSTS_PER_SITE, respectRobots }))
    .slice(0, POSTS_PER_SITE);

  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const post of posts) {
    if (!allowed(post.url)) continue;
    const outcome = await fetchCached(supabase, post.url);
    await sleep(delay);
    if (!outcome.ok) continue;

    const detection = detectGuestPost(outcome.page.html, outcome.page.finalUrl || post.url);
    if (detection.score < DETECT_THRESHOLD) continue;

    // Resolve the author's bio link to a destination root domain.
    const candidate = pickDestinationLink(detection.bioLinks, sourceDomain);
    if (!candidate) continue;

    let destination = destinationFromResolved(candidate, sourceDomain);
    // Follow redirects (shorteners) via the cached fetcher, best-effort.
    try {
      const resolved = await fetchCached(supabase, candidate);
      await sleep(delay);
      if (resolved.ok && resolved.page.finalUrl) {
        destination = destinationFromResolved(resolved.page.finalUrl, sourceDomain) ?? destination;
      }
    } catch {
      // keep the unresolved destination
    }
    if (!destination) continue;

    const dedupeKey = `${post.url}|${destination}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const title = post.title ?? detection.title;
    rows.push({
      workspace_id: site.workspace_id,
      source_domain: sourceDomain,
      source_post_url: post.url,
      author_name: detection.authorName,
      destination_domain: destination,
      published_at: post.publishedAt,
      detection_score: detection.score,
      freshness_score: freshnessScore(post.publishedAt, windowDays),
      latest_post_title: title,
      latest_post_topic: inferTopic(title),
      email_status: "unknown",
      status: "new",
      meta: { discovered_site_id: site.id },
    });
  }

  if (rows.length === 0) return 0;

  const { data: inserted } = await supabase
    .from("active_authors")
    .upsert(rows, {
      onConflict: "workspace_id,source_post_url,destination_domain",
      ignoreDuplicates: true,
    })
    .select("id");

  const created = (inserted ?? []).length;
  if (created > 0) {
    await logActivity(supabase, {
      workspaceId: site.workspace_id,
      action: "discovery.authors_found",
      entityType: "discovered_site",
      entityId: site.id,
      meta: { source_domain: sourceDomain, authors: created },
    });
  }
  return created;
}
