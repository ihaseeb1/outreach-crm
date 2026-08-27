import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { domainFromUrl } from "@/lib/email";
import { logActivity } from "@/lib/activity";
import { suppressedSubset } from "@/mail/suppressions";
import { extractFromHtml } from "@/scraper/extract";
import { crawlDelayMs, fetchRobots, isAllowed } from "@/scraper/robots";
import { crawlableUrl, resolveRespectRobots } from "@/scraper/safety";
import { defaultScraper } from "@/scraper/static-scraper";
import type { ExtractedContact, Scraper } from "@/scraper/types";
import type { Website, WebsiteMeta } from "@/types/db";

/**
 * Cron batch: claim up to `limit` pending websites, scrape each politely, and
 * write deduped contacts. Idempotent — a website is claimed with a conditional
 * update so a re-run (or an overlapping cron tick) cannot double-process it.
 */

export interface ScrapeBatchResult {
  processed: number;
  contactsCreated: number;
  skippedRobots: number;
  failed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runScrapeBatch(
  supabase: SupabaseClient,
  options: { limit?: number; scraper?: Scraper; workspaceId?: string } = {},
): Promise<ScrapeBatchResult> {
  const limit = options.limit ?? 10;
  const scraper = options.scraper ?? defaultScraper;

  let pendingQuery = supabase
    .from("websites")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (options.workspaceId) {
    pendingQuery = pendingQuery.eq("workspace_id", options.workspaceId);
  }

  const { data: pending } = await pendingQuery;

  const result: ScrapeBatchResult = {
    processed: 0,
    contactsCreated: 0,
    skippedRobots: 0,
    failed: 0,
  };

  const touchedJobs = new Set<string>();
  // Per-workspace "respect robots.txt" flag, read once per workspace. The batch
  // mixes websites from many workspaces, so this cannot be a single option.
  const respectRobotsByWorkspace = new Map<string, boolean>();
  const respectRobotsFor = async (workspaceId: string): Promise<boolean> => {
    const cached = respectRobotsByWorkspace.get(workspaceId);
    if (cached !== undefined) return cached;
    const { data } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle();
    const respect = resolveRespectRobots(
      (data as { settings?: Record<string, unknown> } | null)?.settings,
    );
    respectRobotsByWorkspace.set(workspaceId, respect);
    return respect;
  };

  for (const row of (pending ?? []) as Website[]) {
    // Atomic claim: only the caller that flips pending -> scraping proceeds.
    const { data: claimed } = await supabase
      .from("websites")
      .update({ status: "scraping" })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    if (row.scrape_job_id) touchedJobs.add(row.scrape_job_id);

    // SSRF guard: never fetch a private / internal / non-http(s) seed URL.
    const seedGuard = crawlableUrl(row.url);
    if (!seedGuard.ok) {
      result.failed += 1;
      await supabase
        .from("websites")
        .update({
          status: "failed",
          error: seedGuard.reason,
          scraped_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      continue;
    }

    try {
      const respectRobots = await respectRobotsFor(row.workspace_id);
      const outcome = await scrapeWebsite(supabase, row, scraper, respectRobots);
      result.processed += 1;
      result.contactsCreated += outcome.contactsCreated;
      if (outcome.status === "skipped_robots") result.skippedRobots += 1;
      if (outcome.status === "failed") result.failed += 1;
    } catch (error) {
      result.failed += 1;
      await supabase
        .from("websites")
        .update({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          scraped_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    }
  }

  for (const jobId of touchedJobs) {
    await refreshJobProgress(supabase, jobId);
  }

  return result;
}

interface SiteOutcome {
  status: Website["status"];
  contactsCreated: number;
}

async function scrapeWebsite(
  supabase: SupabaseClient,
  site: Website,
  scraper: Scraper,
  respectRobots: boolean,
): Promise<SiteOutcome> {
  const startUrl = site.url;
  const origin = new URL(startUrl).origin;
  const robots = await fetchRobots(origin);
  // Crawl-delay and the politeness floor are always honoured; only the Disallow
  // gating is skipped when a workspace has turned robots off for its own sites.
  const delay = crawlDelayMs(robots);

  if (respectRobots && !isAllowed(robots, new URL(startUrl).pathname)) {
    await supabase
      .from("websites")
      .update({
        status: "skipped_robots",
        error: "Disallowed by robots.txt",
        scraped_at: new Date().toISOString(),
      })
      .eq("id", site.id);
    return { status: "skipped_robots", contactsCreated: 0 };
  }

  const maxPages = Math.max(1, env.scraperMaxPagesPerSite());
  const visited: string[] = [];
  const queue: string[] = [startUrl];
  const found = new Map<string, ExtractedContact>();
  const phones = new Set<string>();
  const social: Record<string, string> = {};
  let title: string | null = null;
  let description: string | null = null;
  let httpStatus: number | null = null;
  let lastError: string | null = null;

  while (queue.length > 0 && visited.length < maxPages) {
    const url = queue.shift();
    if (!url || visited.includes(url)) continue;

    if (respectRobots && !isAllowed(robots, new URL(url).pathname)) continue;
    // A followed link could point at a private/internal host; guard it too.
    if (!crawlableUrl(url).ok) continue;
    if (visited.length > 0) await sleep(delay);

    const outcome = await scraper.fetchPage(url);
    visited.push(url);

    if (!outcome.ok) {
      lastError = outcome.failure.error;
      if (httpStatus === null) httpStatus = outcome.failure.status;
      continue;
    }

    httpStatus = outcome.page.status;
    const extracted = extractFromHtml(outcome.page.html, outcome.page.finalUrl);

    for (const contact of extracted.emails) {
      if (!found.has(contact.email)) found.set(contact.email, contact);
    }
    extracted.phones.forEach((p) => phones.add(p));
    Object.assign(social, extracted.social);
    title ??= extracted.title;
    description ??= extracted.description;

    // Only the homepage seeds the contact-page queue; keeps the crawl shallow.
    if (visited.length === 1) {
      for (const link of extracted.candidateLinks) {
        if (queue.length + visited.length < maxPages && !visited.includes(link)) {
          queue.push(link);
        }
      }
    }
  }

  const contactsCreated = await persistContacts(supabase, site, [...found.values()]);

  const meta: WebsiteMeta = {
    ...site.meta,
    title: title ?? undefined,
    description: description ?? undefined,
    phones: [...phones],
    social,
    pages_crawled: visited,
  };

  const status: Website["status"] =
    visited.length === 0 || (found.size === 0 && lastError) ? "failed" : "done";

  await supabase
    .from("websites")
    .update({
      status,
      http_status: httpStatus,
      emails_found: found.size,
      error: status === "failed" ? lastError : null,
      meta,
      scraped_at: new Date().toISOString(),
    })
    .eq("id", site.id);

  return { status, contactsCreated };
}

async function persistContacts(
  supabase: SupabaseClient,
  site: Website,
  contacts: ExtractedContact[],
): Promise<number> {
  if (contacts.length === 0) return 0;

  // Compliance: an address already on the suppression list is stored as
  // suppressed so it can never be picked up by a campaign.
  const suppressed = await suppressedSubset(
    supabase,
    site.workspace_id,
    contacts.map((c) => c.email),
  );

  const now = new Date().toISOString();
  const rows = contacts.map((contact) => ({
    workspace_id: site.workspace_id,
    website_id: site.id,
    email: contact.email,
    first_name: contact.firstName,
    last_name: contact.lastName,
    website: site.url,
    domain: site.domain || domainFromUrl(site.url),
    source_url: contact.sourceUrl,
    scraped_at: now,
    validation_status: suppressed.has(contact.email) ? "suppressed" : "unknown",
  }));

  const { data, error } = await supabase
    .from("contacts")
    .upsert(rows, { onConflict: "workspace_id,email", ignoreDuplicates: true })
    .select("id");

  if (error) {
    console.error("[scraper] contact upsert failed", error.message);
    return 0;
  }

  const created = (data ?? []).length;
  if (created > 0) {
    await logActivity(supabase, {
      workspaceId: site.workspace_id,
      action: "scrape.contacts_found",
      entityType: "website",
      entityId: site.id,
      meta: { domain: site.domain, created },
    });
  }
  return created;
}

/** Recomputes counters for a job and closes it once nothing is left. */
export async function refreshJobProgress(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  const { data: sites } = await supabase
    .from("websites")
    .select("status, emails_found")
    .eq("scrape_job_id", jobId);

  const rows = (sites ?? []) as { status: string; emails_found: number }[];
  const total = rows.length;
  const processed = rows.filter(
    (r) => r.status === "done" || r.status === "failed" || r.status === "skipped_robots",
  ).length;
  const found = rows.reduce((sum, r) => sum + (r.emails_found ?? 0), 0);
  const complete = total > 0 && processed === total;

  await supabase
    .from("scrape_jobs")
    .update({
      total_count: total,
      processed_count: processed,
      found_count: found,
      status: complete ? "completed" : "running",
      completed_at: complete ? new Date().toISOString() : null,
    })
    .eq("id", jobId);
}
