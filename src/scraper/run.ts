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

/**
 * Reaper thresholds.
 *
 * A website sits in `scraping` only while a worker holds it. The claim is
 * atomic but there is no heartbeat, so a dead worker (killed runner, tick
 * timeout, OOM) leaves the row orphaned: the batch only ever selects
 * `pending`, so nothing would ever pick it up again, and the parent job —
 * which only completes when every site is terminal — would sit in `running`
 * forever. These thresholds bound that failure mode.
 */
/** Claimed longer ago than this without finishing: the worker is presumed dead. */
const STALE_SCRAPING_MS = 30 * 60 * 1000;
/** Times an orphaned website is reclaimed for retry before it is failed outright. */
const MAX_SCRAPE_ATTEMPTS = 3;
/** A `running` job with no activity for this long is timed out and failed. */
const STALE_JOB_MS = 2 * 60 * 60 * 1000;

export async function runScrapeBatch(
  supabase: SupabaseClient,
  options: { limit?: number; scraper?: Scraper; workspaceId?: string } = {},
): Promise<ScrapeBatchResult> {
  const limit = options.limit ?? 10;
  const scraper = options.scraper ?? defaultScraper;

  const result: ScrapeBatchResult = {
    processed: 0,
    contactsCreated: 0,
    skippedRobots: 0,
    failed: 0,
  };

  // Reaper first: reclaim websites orphaned by dead workers and time out jobs
  // that have seen no activity past the deadline, so a crashed run can never
  // leave websites or jobs stuck forever. Reaped websites go back to `pending`
  // (their scrape_job_id is untouched — no data is deleted).
  const reapedJobIds = await reapStaleWebsites(supabase, result);
  await timeoutStaleJobs(supabase, result);

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

  for (const jobId of new Set([...touchedJobs, ...reapedJobIds])) {
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

  // A lead-sourced website (from client-acquisition lead sourcing) stamps a tag
  // onto its contacts so they can be filtered and enrolled as a segment.
  const leadTag = (site.meta as { lead?: { tag?: string } } | null)?.lead?.tag;

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
    ...(leadTag ? { tags: [leadTag] } : {}),
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
  const progress = await jobProgress(supabase, jobId);
  const complete = progress.total > 0 && progress.processed === progress.total;

  await supabase
    .from("scrape_jobs")
    .update({
      total_count: progress.total,
      processed_count: progress.processed,
      found_count: progress.found,
      status: complete ? "completed" : "running",
      completed_at: complete ? new Date().toISOString() : null,
    })
    .eq("id", jobId);
}

interface JobProgress {
  total: number;
  processed: number;
  found: number;
  /** Websites still queued or actively being scraped. */
  pendingOrActive: number;
}

/** Shared counter computation for refresh + timeout decisions. */
async function jobProgress(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobProgress> {
  const { data: sites } = await supabase
    .from("websites")
    .select("status, emails_found")
    .eq("scrape_job_id", jobId);

  const rows = (sites ?? []) as { status: string; emails_found: number }[];
  const isTerminal = (s: string) =>
    s === "done" || s === "failed" || s === "skipped_robots";
  return {
    total: rows.length,
    processed: rows.filter((r) => isTerminal(r.status)).length,
    found: rows.reduce((sum, r) => sum + (r.emails_found ?? 0), 0),
    pendingOrActive: rows.filter(
      (r) => r.status === "pending" || r.status === "scraping",
    ).length,
  };
}

/**
 * Reclaims websites orphaned by dead workers.
 *
 * A row in `scraping` whose `updated_at` is older than STALE_SCRAPING_MS cannot
 * still be held by a live worker — the claim has no heartbeat, so the worker
 * died mid-scrape (killed runner, tick timeout, OOM). Without this, the batch
 * (which only selects `pending`) would never pick the row up again, and the
 * parent job — which only completes when every site is terminal — would sit in
 * `running` forever.
 *
 * Orphaned rows go back to `pending` for retry, with the attempt counted in
 * `meta.scrape_attempts`; after MAX_SCRAPE_ATTEMPTS the site itself is presumed
 * to be the problem and it is failed with an error instead. Returns the ids of
 * the jobs that had sites reaped, so their progress counters get refreshed.
 * Nothing is deleted.
 */
async function reapStaleWebsites(
  supabase: SupabaseClient,
  result: ScrapeBatchResult,
): Promise<Set<string>> {
  const jobIds = new Set<string>();
  const cutoff = new Date(Date.now() - STALE_SCRAPING_MS).toISOString();

  const { data } = await supabase
    .from("websites")
    .select("id, scrape_job_id, meta")
    .eq("status", "scraping")
    .lt("updated_at", cutoff)
    .limit(200);

  const rows = (data ?? []) as {
    id: string;
    scrape_job_id: string | null;
    meta: Record<string, unknown> | null;
  }[];

  for (const row of rows) {
    if (row.scrape_job_id) jobIds.add(row.scrape_job_id);
    const attempts = Number(row.meta?.scrape_attempts ?? 0);
    const meta = { ...(row.meta ?? {}), scrape_attempts: attempts + 1 };

    if (attempts + 1 >= MAX_SCRAPE_ATTEMPTS) {
      // Reclaimed repeatedly but never finishes — the site, not the worker,
      // is the problem. Fail it cleanly with an error; the job can then close.
      result.failed += 1;
      await supabase
        .from("websites")
        .update({
          status: "failed",
          error: `Scrape worker died mid-scrape ${attempts + 1} times — giving up.`,
          meta,
          scraped_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    } else {
      await supabase
        .from("websites")
        .update({ status: "pending", error: null, meta })
        .eq("id", row.id);
    }
  }

  return jobIds;
}

/**
 * Times out `running` jobs that have seen no activity past STALE_JOB_MS.
 *
 * `updated_at` is bumped by a trigger on every write, and refreshJobProgress
 * rewrites the job row on every batch that touches it — so a `running` job
 * with a stale `updated_at` is one no worker has made progress on. Jobs with
 * sites still queued or being scraped are left alone (they are slow, not
 * stuck); a job whose sites are all terminal but never got its final refresh
 * is completed rather than failed. Everything else is marked `failed` with an
 * error. Nothing is deleted.
 */
async function timeoutStaleJobs(
  supabase: SupabaseClient,
  result: ScrapeBatchResult,
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();

  const { data } = await supabase
    .from("scrape_jobs")
    .select("id")
    .eq("status", "running")
    .lt("updated_at", cutoff)
    .limit(50);

  const rows = (data ?? []) as { id: string }[];

  for (const row of rows) {
    const progress = await jobProgress(supabase, row.id);

    if (progress.total > 0 && progress.processed === progress.total) {
      await supabase
        .from("scrape_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          total_count: progress.total,
          processed_count: progress.processed,
          found_count: progress.found,
        })
        .eq("id", row.id);
      continue;
    }

    if (progress.pendingOrActive > 0) continue;

    result.failed += 1;
    await supabase
      .from("scrape_jobs")
      .update({
        status: "failed",
        error:
          "Job timed out: no activity for over 2 hours with nothing left to process.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }
}
