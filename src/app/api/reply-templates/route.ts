import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import {
  REPLY_TEMPLATE_LIMITS,
  readReplyTemplates,
  type ReplyTemplate,
} from "@/mail/reply-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  templates: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(REPLY_TEMPLATE_LIMITS.MAX_NAME),
        body: z.string().min(1).max(REPLY_TEMPLATE_LIMITS.MAX_BODY),
      }),
    )
    .max(REPLY_TEMPLATE_LIMITS.MAX_TEMPLATES),
});

/** Replaces the whole set of reply templates in one write. The list is short
 * enough that sending it whole is simpler and race-free next to per-row edits. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // Re-read settings rather than trusting the session copy: it is a shared jsonb
  // column and another tab may have changed a different key since this page loaded.
  const { data: workspaceRow } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", session.workspace.id)
    .single();

  const current =
    (workspaceRow as { settings: Record<string, unknown> } | null)?.settings ?? {};

  const templates: ReplyTemplate[] = parsed.data.templates.map((t) => ({
    id: t.id,
    name: t.name.trim(),
    body: t.body,
  }));

  const { error } = await supabase
    .from("workspaces")
    .update({ settings: { ...current, reply_templates: templates } })
    .eq("id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, templates });
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    templates: readReplyTemplates(session.workspace.settings),
  });
}
