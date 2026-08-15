import {
  RemoveSuppressionButton,
  SuppressionForm,
} from "@/components/suppression-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Suppression } from "@/types/db";

export const dynamic = "force-dynamic";

export default async function SuppressionsPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data, count } = await supabase
    .from("suppressions")
    .select("*", { count: "exact" })
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as Suppression[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Suppressions</h1>
        <p className="hint mt-1">
          The hard stop. Every send — campaign, follow-up or warmup — is checked
          against this list first. {(count ?? 0).toLocaleString()} entries.
        </p>
      </div>

      <SuppressionForm />

      <section className="card">
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">
            Nothing suppressed yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Reason</th>
                  <th>Source</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium">{row.email}</td>
                    <td>{row.reason.replace("_", " ")}</td>
                    <td>{row.source ?? "—"}</td>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td className="text-right">
                      <RemoveSuppressionButton id={row.id} reason={row.reason} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
