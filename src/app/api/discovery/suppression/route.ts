import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl, normalizeEmail } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addSchema = z.object({
  values: z.string().min(1).max(200_000),
  kind: z.enum(["domain", "email"]),
  reason: z.enum(["competitor", "owned", "unsubscribed", "bounced", "manual"]).default("manual"),
});

/**
 * The discovery blacklist (suppression_list): competitor / owned / manually
 * blocked domains and emails. Separate from the outbound `suppressions` table,
 * so nothing here can affect sending — it only filters discovery + publisher
 * results.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { kind, reason } = parsed.data;
  const values = [
    ...new Set(
      parsed.data.values
        .split(/[\s,;]+/)
        .map((v) => (kind === "email" ? normalizeEmail(v) : domainFromUrl(v)))
        .filter(Boolean),
    ),
  ].slice(0, 5000);

  if (values.length === 0) {
    return NextResponse.json({ error: `No valid ${kind}s found.` }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("suppression_list").upsert(
    values.map((value) => ({
      workspace_id: session.workspace.id,
      value,
      kind,
      reason,
    })),
    { onConflict: "workspace_id,value", ignoreDuplicates: true },
  );

  if (error) {
    return NextResponse.json(
      { error: `${error.message} (is migration 0016 applied?)` },
      { status: 500 },
    );
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "discovery.blacklist_added",
    meta: { kind, reason, count: values.length },
  });

  return NextResponse.json({ ok: true, added: values.length });
}

const deleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("suppression_list")
    .delete()
    .eq("workspace_id", session.workspace.id)
    .in("id", parsed.data.ids)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, removed: (data ?? []).length });
}
