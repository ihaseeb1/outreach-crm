import { LeadRunForm } from "@/components/lead-run-form";
import { LeadRunsTable } from "@/components/lead-runs-table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { LeadRun } from "@/types/db";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  // Best-effort: errors (and stays empty) until migration 0021 is applied.
  const { data, error } = await supabase
    .from("lead_runs")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const runs = (data ?? []) as LeadRun[];
  const needsMigration = Boolean(error);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Find clients</h1>
        <p className="hint mt-1">
          Source potential clients by industry and location (e.g. &ldquo;dentists in
          Texas&rdquo;). Each run finds matching business websites, queues them into
          Prospecting to scrape a contact email, and tags the resulting contacts{" "}
          <code>client-lead</code> so you can enroll them in a cold-outreach campaign.
        </p>
      </div>

      <LeadRunForm />

      {needsMigration && (
        <p className="card card-pad text-sm text-[var(--color-danger)]">
          Lead sourcing isn&apos;t available yet — apply migration{" "}
          <code>0021_lead_sourcing.sql</code> in Supabase, then reload.
        </p>
      )}

      <LeadRunsTable runs={runs} />
    </div>
  );
}
