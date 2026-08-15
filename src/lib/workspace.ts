import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Workspace } from "@/types/db";

export interface SessionContext {
  userId: string;
  email: string;
  workspace: Workspace;
}

/**
 * Resolves the signed-in user and their workspace. Redirects to /login when
 * there is no session, so page components can treat the result as guaranteed.
 */
export async function requireSession(): Promise<SessionContext> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    // The signup trigger creates this; if it is missing something went wrong
    // during signup rather than during this request.
    redirect("/login?error=no-workspace");
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", (membership as { workspace_id: string }).workspace_id)
    .single();

  if (!workspace) redirect("/login?error=no-workspace");

  return {
    userId: user.id,
    email: user.email ?? "",
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
    workspace: workspace as Workspace,
  };
}
