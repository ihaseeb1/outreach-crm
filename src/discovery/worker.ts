import type { SupabaseClient } from "@supabase/supabase-js";

import { runDiscoveryBatch } from "@/discovery/run";
import { runPublisherCrawlBatch } from "@/discovery/crawl/run";
import { runEnrichBatch } from "@/discovery/enrich/run";
import { runLeadBatch } from "@/leads/run";

/**
 * The local discovery worker's one tick.
 *
 * The heavy discovery work — SERP sweeps, publisher crawling, contact
 * enrichment — is too slow for a serverless function's 60s budget, so it runs
 * in a long-lived local process (`npm run worker`, scripts/discovery-worker.ts)
 * that has no timeout and talks to the same Supabase database as the app.
 *
 * This is the seam every batch runner hangs off. It is filled in phase by
 * phase; each runner claims its own rows with a conditional update, so a tick
 * is idempotent and two overlapping workers cannot double-process a row.
 */

export interface WorkerTickResult {
  discovery: number;
  publishers: number;
  enrich: number;
  leads: number;
}

export interface WorkerTickOptions {
  /** Rows to process per runner, per tick. */
  limit?: number;
  workspaceId?: string;
}

export async function runDiscoveryWorkerTick(
  supabase: SupabaseClient,
  options: WorkerTickOptions = {},
): Promise<WorkerTickResult> {
  // Wired up in Phases 1, 3 and 4:
  //   discovery  -> runDiscoveryBatch      (Phase 1)  [done]
  //   publishers -> runPublisherCrawlBatch (Phase 3)  [done]
  //   enrich     -> runEnrichBatch         (Phase 4)  [done]
  const discovery = await runDiscoveryBatch(supabase, {
    limit: 1,
    workspaceId: options.workspaceId,
  });
  const publishers = await runPublisherCrawlBatch(supabase, {
    limit: options.limit ?? 2,
    workspaceId: options.workspaceId,
  });
  const enrich = await runEnrichBatch(supabase, {
    limit: (options.limit ?? 2) * 2,
    workspaceId: options.workspaceId,
  });
  // Lead sourcing (client acquisition) runs on the same keyless search stack, so
  // it belongs on the same local worker as discovery.
  const leads = await runLeadBatch(supabase, {
    limit: 1,
    workspaceId: options.workspaceId,
  });

  return {
    discovery: discovery.runsProcessed,
    publishers: publishers.sitesProcessed,
    enrich: enrich.processed,
    leads: leads.runsProcessed,
  };
}

export function tickIsIdle(result: WorkerTickResult): boolean {
  return result.discovery + result.publishers + result.enrich + result.leads === 0;
}
