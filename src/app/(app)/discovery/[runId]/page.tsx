import Link from "next/link";
import { notFound } from "next/navigation";

import {
  DiscoveryResultsTable,
  type DiscoveryResultRow,
} from "@/components/discovery-results-table";
import { LiveRefresh } from "@/components/live-refresh";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import { ISO_3166 } from "@/discovery/geo";
import type { DiscoveredSite, DiscoveryRun } from "@/types/db";

export const dynamic = "force-dynamic";

function geoLabel(code: string): string {
  if (code === "WORLDWIDE") return "Worldwide";
  return ISO_3166[code] ?? code;
}

export default async function DiscoveryRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const session = await requireSession();
  const { runId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: runData } = await supabase
    .from("discovery_runs")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .eq("id", runId)
    .maybeSingle();

  if (!runData) notFound();
  const run = runData as DiscoveryRun;

  const { data: siteData } = await supabase
    .from("discovered_sites")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .eq("run_id", runId)
    .order("opportunity_score", { ascending: false, nullsFirst: false })
    .limit(1000);

  const rows: DiscoveryResultRow[] = ((siteData ?? []) as DiscoveredSite[]).map((s) => ({
    id: s.id,
    root_domain: s.root_domain,
    guest_post_url: s.guest_post_url,
    matched_footprint: s.matched_footprint,
    best_position: s.best_position,
    opportunity_score: s.opportunity_score,
    status: s.status,
    pushed_website_id: s.pushed_website_id,
  }));

  const inFlight = run.status === "pending" || run.status === "running";
  const pct =
    run.total_queries > 0
      ? Math.round((run.processed_queries / run.total_queries) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <LiveRefresh active={inFlight} />

      <div>
        <Link href="/discovery" className="hint">
          ← All runs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{run.niche}</h1>
        <p className="hint mt-1">
          {geoLabel(run.geo)} · {run.status}
          {run.engines.length > 0 && ` · via ${run.engines.join(", ")}`}
          {run.error && (
            <span className="text-[var(--color-danger)]"> · {run.error}</span>
          )}
        </p>
      </div>

      <div className="card card-pad">
        <div className="flex items-center justify-between text-sm">
          <span>
            {run.processed_queries}/{run.total_queries} queries · {run.found_count}{" "}
            sites found
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--color-canvas)]">
          <div
            className="h-full rounded-full bg-[var(--color-brand)] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        {inFlight && (
          <p className="hint mt-2">
            Queued for the local worker. Keyless search only works from a
            residential IP, so start <code>npm run worker</code> on your machine
            and this run will process (or configure Google CSE for cloud search).
            This page updates itself.
          </p>
        )}
      </div>

      {!inFlight && run.status === "completed" && rows.length === 0 && (
        <div className="card card-pad space-y-2 border-[var(--color-warn)]">
          <p className="font-medium">No sites found for this run.</p>
          <p className="hint">
            On the free tier, keyless search engines (DuckDuckGo, Bing) block or
            degrade requests from cloud servers, so a run started on the live
            site often returns nothing. To get real results, pick one:
          </p>
          <ul className="hint ml-4 list-disc space-y-1">
            <li>
              <b>Google Custom Search (free, 100/day):</b> add
              <code> GOOGLE_CSE_KEY</code>, <code>GOOGLE_CSE_CX</code> and
              <code> SEARCH_ENGINES=google_cse</code> in your Vercel env, then
              re-run. This works from the cloud and honours search operators.
            </li>
            <li>
              <b>Local worker:</b> run <code>npm run worker</code> on your own
              machine (DuckDuckGo works from a residential IP). New runs then
              process there automatically.
            </li>
          </ul>
        </div>
      )}

      <DiscoveryResultsTable rows={rows} runId={run.id} />
    </div>
  );
}
