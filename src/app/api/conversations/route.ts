import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  id: z.string().uuid(),
  is_read: z.boolean().optional(),
  status: z.enum(["open", "snoozed", "closed"]).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

/** Read/unread, assignment, and open/closed state for a conversation. */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id, ...patch } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from("conversations")
    .update(patch)
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
