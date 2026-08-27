import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AppRole, AccountStatus, Workspace } from "@/types/db";

export interface SessionContext {
  userId: string;
  email: string;
  status: AccountStatus;
  appRole: AppRole;
  workspace: Workspace;
}

interface ProfileFacts {
  status: AccountStatus;
  appRole: AppRole;
}

/**
 * Reads the caller's account status and role from their own profile (the
 * profiles "self read" policy always permits this). Survives a deploy that
 * lands before migration 0009: if the status/app_role columns are not there
 * yet, the read of them errors and we fall back to treating the account as an
 * active member — i.e. the pre-gate behaviour — so no one is locked out in the
 * window between deploying and applying the SQL.
 */
async function loadProfileFacts(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
): Promise<ProfileFacts> {
  const { data, error } = await supabase
    .from("profiles")
    .select("status, app_role")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) {
    return { status: "active", appRole: "member" };
  }
  const row = data as { status?: string | null; app_role?: string | null };
  return {
    status: (row.status as AccountStatus) ?? "active",
    appRole: (row.app_role as AppRole) ?? "member",
  };
}

/** Where an account that is not `active` should be sent. */
function gateRedirect(status: AccountStatus): string {
  if (status === "rejected") return "/pending?state=rejected";
  if (status === "banned") return "/pending?state=banned";
  return "/pending";
}

/**
 * Resolves the signed-in user, their approval status, and their workspace.
 *
 * Auth failure (no user) is the only thing that sends someone to /login. An
 * authenticated account that is merely unapproved goes to /pending, and an
 * active account whose workspace row cannot be read is treated as a data issue,
 * not a logout — it also goes to /pending (with a note) rather than bouncing to
 * /login. This is the §5.2 fix: an empty RLS-gated workspace read used to look
 * exactly like being logged out.
 */
export async function requireSession(): Promise<SessionContext> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const facts = await loadProfileFacts(supabase, user.id);
  if (facts.status !== "active") redirect(gateRedirect(facts.status));

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) redirect("/pending?issue=workspace");

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", (membership as { workspace_id: string }).workspace_id)
    .single();

  if (!workspace) redirect("/pending?issue=workspace");

  return {
    userId: user.id,
    email: user.email ?? "",
    status: facts.status,
    appRole: facts.appRole,
    workspace: workspace as Workspace,
  };
}

/** Same as requireSession but returns null instead of redirecting. */
export async function getSession(): Promise<SessionContext | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const facts = await loadProfileFacts(supabase, user.id);
  if (facts.status !== "active") return null;

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!membership) return null;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", (membership as { workspace_id: string }).workspace_id)
    .single();
  if (!workspace) return null;

  return {
    userId: user.id,
    email: user.email ?? "",
    status: facts.status,
    appRole: facts.appRole,
    workspace: workspace as Workspace,
  };
}

/**
 * Requires an active app admin (super_admin or admin). A signed-in non-admin is
 * sent to the dashboard rather than shown a 403 — the Approvals link is only
 * rendered for admins, so a non-admin reaching this route is a stray link.
 */
export async function requireAdmin(): Promise<SessionContext> {
  const session = await requireSession();
  if (session.appRole !== "super_admin" && session.appRole !== "admin") {
    redirect("/dashboard");
  }
  return session;
}
