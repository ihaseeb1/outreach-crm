import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  workspaceName: z.string().trim().max(80).optional(),
});

/**
 * Server-side signup so the registration flags are enforced where they cannot
 * be bypassed (spec §5.1):
 *   - SIGNUPS_OPEN=false      → registration refused outright.
 *   - SIGNUPS_REQUIRE_APPROVAL → the account is left `pending` (the DB default)
 *     and an admin must approve it; when false, it is activated immediately.
 *
 * The account is created with the service role (email pre-confirmed, so it does
 * not depend on Supabase's mailer); handle_new_user() provisions the profile,
 * workspace and owner membership. No session is returned — a pending user has
 * nothing to sign in to yet — so the client shows a "what happens next" message.
 */
export async function POST(request: Request) {
  if (!env.signupsOpen()) {
    return NextResponse.json(
      { error: "Registration is currently closed." },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid email and a password of at least 8 characters." },
      { status: 400 },
    );
  }
  const { email, password, workspaceName } = parsed.data;

  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { workspace_name: workspaceName ?? "" },
  });

  if (error || !data.user) {
    // Supabase returns a clear message for a duplicate address.
    return NextResponse.json(
      { error: error?.message ?? "Could not create the account." },
      { status: 400 },
    );
  }

  const requiresApproval = env.signupsRequireApproval();
  if (!requiresApproval) {
    await admin
      .from("profiles")
      .update({ status: "active", approved_at: new Date().toISOString() })
      .eq("id", data.user.id);
  }

  return NextResponse.json({ ok: true, requiresApproval });
}
