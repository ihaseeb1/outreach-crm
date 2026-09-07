import { DiscoveryRunForm } from "@/components/discovery-run-form";
import { DiscoveryRunsTable } from "@/components/discovery-runs-table";
import { DiscoveryBlacklist } from "@/components/discovery-blacklist";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { DiscoveryRun, SuppressionListEntry } from "@/types/db";

export const dynamic = "force-dynamic";

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

      <DiscoveryRunsTable runs={runs} />
    </div>
  );
}
