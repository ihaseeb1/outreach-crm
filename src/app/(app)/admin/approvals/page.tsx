import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/workspace";
import { ApprovalsTable, type ApprovalRow } from "@/components/approvals-table";

export const dynamic = "force-dynamic";

/**
 * Signup approvals (spec §5.1). Admin-only — requireAdmin sends non-admins to
 * the dashboard. The list is read with the service role so an admin can see
 * every account, including pending ones they are not yet a workspace-mate of.
 */
export default async function ApprovalsPage() {
  const session = await requireAdmin();
  const admin = createSupabaseAdminClient();

  const { data } = await admin
    .from("profiles")
    .select("id, email, full_name, status, app_role, created_at, approved_at")
    .order("created_at", { ascending: false })
    .limit(500);

  const rows = (data ?? []) as ApprovalRow[];
  // Pending first — that is the queue an admin comes here to clear.
  rows.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));

  const pending = rows.filter((row) => row.status === "pending").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="hint mt-1">
          New signups start as <strong>pending</strong> and can access nothing
          until approved. {pending > 0 ? `${pending} waiting.` : "Nothing waiting."}
        </p>
      </div>

      <ApprovalsTable rows={rows} currentUserId={session.userId} />
    </div>
  );
}
