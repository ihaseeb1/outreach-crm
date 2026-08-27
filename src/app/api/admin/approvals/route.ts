import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(["approve", "reject", "ban"]),
});

const NEXT_STATUS = {
  approve: "active",
  reject: "rejected",
  ban: "banned",
} as const;

/**
 * Approve / reject / ban a signup (spec §5.1). Authorisation is server-side:
 * the caller must be an active app admin, and the target may not be the caller
 * or a super_admin (so an admin cannot lock out the owner). The write goes
 * through the service role, and every action is recorded in the activity log.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.appRole !== "super_admin" && session.appRole !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { userId, action } = parsed.data;

  if (userId === session.userId) {
    return NextResponse.json(
      { error: "You cannot change your own account status." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();

  const { data: target } = await admin
    .from("profiles")
    .select("id, email, status, app_role")
    .eq("id", userId)
    .maybeSingle();

  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  const targetRow = target as { email: string; app_role: string };
  if (targetRow.app_role === "super_admin") {
    return NextResponse.json(
      { error: "A super admin account cannot be changed here." },
      { status: 400 },
    );
  }

  const status = NEXT_STATUS[action];
  const { error } = await admin
    .from("profiles")
    .update({
      status,
      approved_at: action === "approve" ? new Date().toISOString() : null,
      approved_by: action === "approve" ? session.userId : null,
    })
    .eq("id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity(admin, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: `account.${action}`,
    entityType: "profile",
    entityId: userId,
    meta: { email: targetRow.email, new_status: status },
  });

  return NextResponse.json({ ok: true, status });
}
