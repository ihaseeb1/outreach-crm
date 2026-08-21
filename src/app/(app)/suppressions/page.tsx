import { SuppressionForm } from "@/components/suppression-form";
import {
  SuppressionTable,
  type SuppressionRow,
} from "@/components/suppression-table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Suppression } from "@/types/db";

export const dynamic = "force-dynamic";

/** Rows loaded for the table. Above this the search would need to go server-side. */
const PAGE_LIMIT = 1000;

export default async function SuppressionsPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data, count } = await supabase
    .from("suppressions")
    .select("*", { count: "exact" })
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_LIMIT);

  const rows: SuppressionRow[] = ((data ?? []) as Suppression[]).map((row) => ({
    id: row.id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    created_at: row.created_at,
  }));

  const total = count ?? rows.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Suppressions</h1>
        <p className="hint mt-1">
          The hard stop. Every send — campaign, follow-up or warmup — is checked
          against this list first. {total.toLocaleString()} entries
          {total > rows.length && `, newest ${rows.length.toLocaleString()} shown`}.
        </p>
      </div>

      <SuppressionForm />

      <SuppressionTable rows={rows} total={total} />
    </div>
  );
}
