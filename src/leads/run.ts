import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { domainFromUrl } from "@/lib/email";
import { logActivity } from "@/lib/activity";
import { getGeoParams } from "@/discovery/geo";
import { expandLeadQueries } from "@/leads/footprints";
import { cloudSearchViable, getProviders, runSearch } from "@/discovery/search";
import { isNoiseDomain } from "@/discovery/platformNoise";
import {
  isDomainSuppressed,
  loadSuppressionSets,
} from "@/discovery/suppression";
import type { LeadRun } from "@/types/db";

/**
 * Client-acquisition lead sourcing.
 *
 * A lead run searches keyless engines with business-finding queries (industry ×
 * location), collects the business domains, and queues the new ones into the
 * existing prospecting `websites` table under a single scrape_job — so the
 * scrape cron extracts contact emails exactly as it does for any prospecting
 * batch. Those contacts are tagged `client-lead` so they can be filtered and
 * enrolled into a client-acquisition campaign.
 *
 * The run is claimed pending -> running with a conditional update so overlapping
 * ticks can't double-process it. Mirrors src/discovery/run.ts by design.
 */

export interface LeadBatchResult {
  runsProcessed: number;
  sitesFound: number;
}

/** Tag stamped on websites (and inherited by their scraped contacts). */
export const LEAD_TAG = "client-lead";

export async function runLeadBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<LeadBatchResult> {
  const limit = options.limit ?? 1;
  const result: LeadBatchResult = { runsProcessed: 0, sitesFound: 0 };

  // Same cloud/keyless split as discovery: keyless engines are blocked from
  // datacenter IPs, so leave pending runs for the local worker unless a
  // cloud-capable engine is configured.
  if (!cloudSearchViable() && !env.discoveryLocal()) return result;

  let pendingQuery = supabase
    .from("lead_runs")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (options.workspaceId) pendingQuery = pendingQuery.eq("workspace_id", options.workspaceId);

  const { data: pending, error } = await pendingQuery;
  if (error) return result; // table absent (pre-0021) or transient.

  for (const run of (pending ?? []) as LeadRun[]) {
    const { data: claimed } = await supabase
      .from("lead_runs")
      .update({ status: "running" })
      .eq("id", run.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const found = await executeLeadRun(supabase, run);
      result.runsProcessed += 1;
      result.sitesFound += found;
    } catch (err) {
      await supabase
        .from("lead_runs")
        .update({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id);
    }
  }

  return result;
}

/** Executes ONE run by id inline (the "Start run" path). */
export async function runLeadRunById(
  supabase: SupabaseClient,
  runId: string,
): Promise<number> {
  const { data: claimed } = await supabase
    .from("lead_runs")
    .update({ status: "running" })
    .eq("id", runId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (!claimed) return 0;

  try {
    return await executeLeadRun(supabase, claimed as LeadRun);
  } catch (err) {
    await supabase
      .from("lead_runs")
      .update({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return 0;
  }
}

async function executeLeadRun(supabase: SupabaseClient, run: LeadRun): Promise<number> {
  const cap = env.maxSearchQueriesPerRun();
  const queries = (
    run.queries?.length ? run.queries : expandLeadQueries(run.industry, run.location)
  ).slice(0, cap);
  const geo = getGeoParams(run.geo);
  const providers = getProviders();

  await supabase
    .from("lead_runs")
    .update({
      total_queries: queries.length,
      engines: providers.map((p) => p.name),
      processed_queries: 0,
    })
    .eq("id", run.id);

  const suppression = await loadSuppressionSets(supabase, run.workspace_id);

  // Best domain per root, across all queries (lowest position wins).
  const byDomain = new Map<string, { domain: string; position: number }>();

  const queryResults = await runSearch(queries, {
    geo,
    providers,
    perQueryLimit: env.resultsPerQuery(),
    concurrency: 1,
    perQueryDelayMs: 2500,
    onProgress: async (done) => {
      await supabase.from("lead_runs").update({ processed_queries: done }).eq("id", run.id);
    },
  });

  for (const { hits } of queryResults) {
    for (const hit of hits) {
      const domain = domainFromUrl(hit.url);
      if (!domain) continue;
      if (isNoiseDomain(domain)) continue; // drops directories/social/aggregators
      if (isDomainSuppressed(domain, suppression)) continue;
      const existing = byDomain.get(domain);
      if (!existing || hit.position < existing.position) {
        byDomain.set(domain, { domain, position: hit.position });
      }
    }
  }

  const domains = [...byDomain.keys()];
  const queued = domains.length ? await queueWebsites(supabase, run, domains) : { queued: 0, jobId: null };

  await supabase
    .from("lead_runs")
    .update({
      status: "completed",
      processed_queries: queries.length,
      found_count: queued.queued,
      scrape_job_id: queued.jobId,
      error: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  await logActivity(supabase, {
    workspaceId: run.workspace_id,
    action: "leads.run_completed",
    entityType: "lead_run",
    entityId: run.id,
    meta: {
      industry: run.industry,
      location: run.location,
      queries: queries.length,
      queued: queued.queued,
    },
  });

  return queued.queued;
}

/**
 * Queues new business domains into the prospecting `websites` table under one
 * scrape_job. Domains already known to prospecting are skipped so a re-run
 * queues nothing twice. Returns the count queued and the job id.
 */
async function queueWebsites(
  supabase: SupabaseClient,
  run: LeadRun,
  domains: string[],
): Promise<{ queued: number; jobId: string | null }> {
  // Which domains are already prospecting websites for this workspace?
  const known = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const { data } = await supabase
      .from("websites")
      .select("domain")
      .eq("workspace_id", run.workspace_id)
      .in("domain", domains.slice(i, i + CHUNK));
    for (const row of (data ?? []) as { domain: string }[]) known.add(row.domain);
  }

  const fresh = domains.filter((d) => !known.has(d));
  if (fresh.length === 0) return { queued: 0, jobId: null };

  const { data: job, error: jobError } = await supabase
    .from("scrape_jobs")
    .insert({
      workspace_id: run.workspace_id,
      created_by: run.created_by,
      input_urls: fresh.map((d) => `https://${d}`),
      status: "pending",
      total_count: fresh.length,
    })
    .select("id")
    .single();
  if (jobError || !job) throw new Error(jobError?.message ?? "Could not create prospecting job.");
  const jobId = (job as { id: string }).id;

  const rows = fresh.map((domain) => ({
    workspace_id: run.workspace_id,
    scrape_job_id: jobId,
    url: `https://${domain}`,
    domain,
    status: "pending",
    emails_found: 0,
    meta: {
      lead: {
        run_id: run.id,
        industry: run.industry,
        location: run.location,
        // Stamped onto contacts by the scraper so client-acquisition leads are
        // filterable and enrollable as a segment.
        tag: LEAD_TAG,
      },
    },
  }));

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from("websites").insert(rows.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
  }

  return { queued: fresh.length, jobId };
}
