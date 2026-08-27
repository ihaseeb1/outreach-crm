import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The waiting room for accounts that are not yet active. Deliberately outside
 * the (app) route group so it never calls requireSession (which would bounce a
 * pending user straight back here). An already-active account is sent on to the
 * dashboard, so a stale link here never traps an approved user.
 */
export default async function PendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data } = await supabase
    .from("profiles")
    .select("status")
    .eq("id", user.id)
    .maybeSingle();
  const status = (data as { status?: string } | null)?.status ?? "active";

  if (status === "active") redirect("/dashboard");

  const state =
    typeof query.state === "string"
      ? query.state
      : status === "rejected" || status === "banned"
        ? status
        : query.issue === "workspace"
          ? "workspace"
          : "pending";

  const copy: Record<string, { title: string; body: string }> = {
    pending: {
      title: "Awaiting approval",
      body: "Your account has been created and is waiting for an administrator to approve it. You'll be able to sign in and use the workspace once it's approved.",
    },
    rejected: {
      title: "Access not granted",
      body: "This account was not approved for access. If you think this is a mistake, contact the administrator who manages this workspace.",
    },
    banned: {
      title: "Account suspended",
      body: "Access for this account has been suspended. Contact the administrator if you believe this is an error.",
    },
    workspace: {
      title: "Setting up your workspace",
      body: "Your account is active but we couldn't load a workspace for it. This is usually momentary — try again shortly. If it persists, contact the administrator.",
    },
  };

  const { title, body } = copy[state] ?? copy.pending!;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card card-pad w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="hint mt-1">Outreach CRM</p>
        </div>
        <p className="text-sm text-[var(--color-muted)]">{body}</p>
        <p className="hint">
          Signed in as <strong>{user.email}</strong>.
        </p>
        <form action="/auth/signout" method="post">
          <button className="btn-secondary w-full" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
