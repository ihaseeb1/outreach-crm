import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  id: z.string().uuid(),
  pipeline_stage: z.string().min(1).max(40).optional(),
  first_name: z.string().max(120).nullable().optional(),
  last_name: z.string().max(120).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

/** Updates a contact — used by the pipeline board and the contact page. */
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

  if (patch.pipeline_stage) {
    const { data: stage } = await supabase
      .from("pipeline_stages")
      .select("key")
      .eq("workspace_id", session.workspace.id)
      .eq("key", patch.pipeline_stage)
      .maybeSingle();

    if (!stage) {
      return NextResponse.json({ error: "Unknown stage." }, { status: 400 });
    }
  }

  const { error } = await supabase
    .from("contacts")
    .update(patch)
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (patch.pipeline_stage) {
    await logActivity(supabase, {
      workspaceId: session.workspace.id,
      actorId: session.userId,
      action: "contact.stage_changed",
      entityType: "contact",
      entityId: id,
      meta: { stage: patch.pipeline_stage },
    });
  }

  return NextResponse.json({ ok: true });
}
