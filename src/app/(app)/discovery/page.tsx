import Link from "next/link";

import { DiscoveryRunForm } from "@/components/discovery-run-form";
import { DiscoveryBlacklist } from "@/components/discovery-blacklist";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import { ISO_3166 } from "@/discovery/geo";
import type { DiscoveryRun, SuppressionListEntry } from "@/types/db";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  pending: "text-[var(--color-muted)]",
  running: "text-[var(--color-brand)]",
  completed: "text-[var(--color-ok)]",
  failed: "text-[var(--color-danger)]",
};

function geoLabel(code: string): string {
  if (code === "WORLDWIDE") return "Worldwide";
  return ISO_3166[code] ?? code;
}

export default async function DiscoveryPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  // Best-effort: the query errors (and runs stays empty) until migration 0016
  // is applied, so the page and form render regardless.
  const { data, error } = await supabase
    .from("discovery_runs")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const runs = (data ?? []) as DiscoveryRun[];
  const needsMigration = Boolean(error);

  const { data: blacklistData } = await supabase
    .from("suppression_list")
    .select("id, value, kind, reason")
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(500);
  const blacklist = (blacklistData ?? []) as Pick<
    SuppressionListEntry,
    "id" | "value" | "kind" | "reason"
  >[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Discovery</h1>
        <p className="hint mt-1">
          Find sites that accept guest posts. A run searches your niche across
          guest-post footprints worldwide (or in one country), filters out
          platforms and anything you&apos;ve suppressed, and scores each site by
          opportunity.
        </p>
      </div>

      <DiscoveryRunForm />

      <DiscoveryBlacklist rows={blacklist} />

      {needsMigration && (
        <p className="card card-pad text-sm text-[var(--color-danger)]">
          Discovery tables aren&apos;t available yet — apply migration{" "}
          <code>0016_discovery.sql</code> in Supabase, then reload.
        </p>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Niche</th>
              <th>Region</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Found</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="hint py-6 text-center">
                  No runs yet. Start one above.
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link
                    href={`/discovery/${run.id}`}
                    className="font-medium text-[var(--color-brand)]"
                  >
                    {run.niche}
                  </Link>
                </td>
                <td>{geoLabel(run.geo)}</td>
                <td className={STATUS_TONE[run.status] ?? ""}>{run.status}</td>
                <td className="hint">
                  {run.processed_queries}/{run.total_queries}
                </td>
                <td>{run.found_count}</td>
                <td className="hint">
                  {new Date(run.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
