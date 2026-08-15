import { NextResponse } from "next/server";
import { z } from "zod";

import { normalizeEmail } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { suppressEmail } from "@/mail/suppressions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addSchema = z.object({
  emails: z.string().min(1).max(200_000),
  reason: z
    .enum(["unsubscribed", "hard_bounce", "complaint", "manual", "opted_out"])
    .default("manual"),
});

/** Manually add addresses to the suppression list. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const emails = [
    ...new Set(
      parsed.data.emails
        .split(/[\s,;]+/)
        .map(normalizeEmail)
        .filter((value) => value.includes("@")),
    ),
  ].slice(0, 5000);

  if (emails.length === 0) {
    return NextResponse.json({ error: "No valid addresses." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  for (const email of emails) {
    await suppressEmail(supabase, {
      workspaceId: session.workspace.id,
      email,
      reason: parsed.data.reason,
      source: "manual_ui",
      actorId: session.userId,
    });
  }

  return NextResponse.json({ ok: true, added: emails.length });
}

/**
 * Removing a suppression is deliberately restricted to entries added manually
 * or by an unsubscribe that the recipient asked to reverse — hard bounces and
 * complaints stay put.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: row } = await supabase
    .from("suppressions")
    .select("id, reason")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const reason = (row as { reason: string }).reason;
  if (reason === "hard_bounce" || reason === "complaint") {
    return NextResponse.json(
      {
        error:
          "Bounced and complained addresses cannot be un-suppressed — removing them would risk your sending reputation.",
      },
      { status: 400 },
    );
  }

  await supabase.from("suppressions").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}
