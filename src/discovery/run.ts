import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { domainFromUrl } from "@/lib/email";
import { logActivity } from "@/lib/activity";
import { getGeoParams } from "@/discovery/geo";
import { expandFootprints } from "@/discovery/footprints";
import { getProviders, runSearch } from "@/discovery/search";
import type { SearchHit } from "@/discovery/search/provider";
import { isNoiseDomain } from "@/discovery/platformNoise";
import { scoreOpportunity } from "@/discovery/score/opportunity";
import {
  isDomainSuppressed,
  loadKnownDomains,
  loadSuppressionSets,
} from "@/discovery/suppression";
import type { DiscoveryRun } from "@/types/db";

/**
 * Cron/worker batch: claim a pending discovery run and execute its SERP sweep.
 *
 * One run does a lot of searching, so a tick processes at most one run and the
 * worker's own loop picks up the next. The run is claimed with a conditional
 * update (pending -> running), so overlapping ticks cannot double-process it,
 * and results upsert on (run_id, root_domain) so a re-run creates no duplicates.
 */

export interface DiscoveryBatchResult {
  runsProcessed: number;
  sitesFound: number;
}

/** URL path signals an actual contribute/guest-post page (a stronger lead). */
const CONTRIBUTE_HINTS = [
  "write-for-us",
  "write_for_us",
  "writeforus",
  "guest-post",
  "guest_post",
  "guestpost",
  "guest-contributor",
  "become-a-contributor",
  "contribute",
  "submit-article",
  "submit-a-post",
  "guidelines",
];

function contributeUrlSignal(url: string | null): boolean {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return CONTRIBUTE_HINTS.some((hint) => path.includes(hint));
  } catch {
    return false;
  }
}

interface Aggregated {
  root_domain: string;
  guest_post_url: string;
  matched_footprint: string;
  best_position: number;
  title: string | null;
  description: string | null;
}

export async function runDiscoveryBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<DiscoveryBatchResult> {
  const limit = options.limit ?? 1;
  const result: DiscoveryBatchResult = { runsProcessed: 0, sitesFound: 0 };

  let pendingQuery = supabase
    .from("discovery_runs")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (options.workspaceId) pendingQuery = pendingQuery.eq("workspace_id", options.workspaceId);

  const { data: pending, error } = await pendingQuery;
  if (error) return result; // table absent (pre-0016) or transient — nothing to do.

  for (const run of (pending ?? []) as DiscoveryRun[]) {
    // Atomic claim: only the caller that flips pending -> running proceeds.
    const { data: claimed } = await supabase
      .from("discovery_runs")
      .update({ status: "running" })
      .eq("id", run.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const found = await executeRun(supabase, run);
      result.runsProcessed += 1;
      result.sitesFound += found;
    } catch (err) {
      await supabase
        .from("discovery_runs")
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

async function executeRun(supabase: SupabaseClient, run: DiscoveryRun): Promise<number> {
  const cap = env.maxSearchQueriesPerRun();
  const queries = (run.queries?.length ? run.queries : expandFootprints(run.niche)).slice(0, cap);
  const geo = getGeoParams(run.geo);
  const providers = getProviders();
  const engineNames = providers.map((p) => p.name);

  await supabase
    .from("discovery_runs")
    .update({ total_queries: queries.length, engines: engineNames, processed_queries: 0 })
    .eq("id", run.id);

  // Guards: competitor/owned suppression + domains seen in prior runs.
  const [suppression, knownDomains] = await Promise.all([
    loadSuppressionSets(supabase, run.workspace_id),
    loadKnownDomains(supabase, run.workspace_id, { excludeRunId: run.id }),
  ]);

  // Aggregate best hit per root domain across all queries.
  const byDomain = new Map<string, Aggregated>();

  const queryResults = await runSearch(queries, {
    geo,
    providers,
    onProgress: async (done) => {
      // Stream progress: the run page reads processed_queries live.
      await supabase
        .from("discovery_runs")
        .update({ processed_queries: done })
        .eq("id", run.id);
    },
  });

  for (const { query, hits } of queryResults) {
    for (const hit of hits) {
      const domain = domainFromUrl(hit.url);
      if (!domain) continue;
      if (isNoiseDomain(domain)) continue;
      if (isDomainSuppressed(domain, suppression)) continue;
      if (knownDomains.has(domain)) continue;

      const existing = byDomain.get(domain);
      if (!existing || hit.position < existing.best_position) {
        byDomain.set(domain, {
          root_domain: domain,
          guest_post_url: hit.url,
          matched_footprint: query,
          best_position: hit.position,
          title: hit.title,
          description: hit.description,
        });
      }
    }
  }

  const rows = [...byDomain.values()].map((agg) => ({
    workspace_id: run.workspace_id,
    run_id: run.id,
    root_domain: agg.root_domain,
    guest_post_url: agg.guest_post_url,
    matched_footprint: agg.matched_footprint,
    best_position: agg.best_position,
    title: agg.title,
    description: agg.description,
    opportunity_score: scoreOpportunity({
      hasWriteForUsPage: contributeUrlSignal(agg.guest_post_url),
      bestPosition: agg.best_position,
    }),
    has_contact_info: false,
    status: "new" as const,
  }));

  if (rows.length > 0) {
    // Upsert in chunks; ignoreDuplicates keeps a re-run idempotent.
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await supabase
        .from("discovered_sites")
        .upsert(rows.slice(i, i + CHUNK), {
          onConflict: "run_id,root_domain",
          ignoreDuplicates: true,
        });
    }
  }

  await supabase
    .from("discovery_runs")
    .update({
      status: "completed",
      processed_queries: queries.length,
      found_count: rows.length,
      error: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  await logActivity(supabase, {
    workspaceId: run.workspace_id,
    action: "discovery.run_completed",
    entityType: "discovery_run",
    entityId: run.id,
    meta: { niche: run.niche, geo: run.geo, queries: queries.length, found: rows.length },
  });

  return rows.length;
}
