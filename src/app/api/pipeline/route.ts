import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stageSchema = z.object({
  id: z.string().uuid().optional(),
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Use lowercase letters, numbers and underscores."),
  label: z.string().min(1).max(60),
  color: z.string().max(20).default("gray"),
  is_won: z.boolean().default(false),
  is_lost: z.boolean().default(false),
});

const bodySchema = z.object({
  stages: z.array(stageSchema).min(1).max(20),
});

/** Replaces the workspace's pipeline definition, preserving stage order. */
export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const keys = parsed.data.stages.map((stage) => stage.key);
  if (new Set(keys).size !== keys.length) {
    return NextResponse.json(
      { error: "Stage keys must be unique." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();

  const { data: existingRows } = await supabase
    .from("pipeline_stages")
    .select("key")
    .eq("workspace_id", session.workspace.id);
  const existingKeys = new Set(
    ((existingRows ?? []) as { key: string }[]).map((row) => row.key),
  );

  // Contacts sitting in a removed stage would become invisible on the board, so
  // move them to the first stage instead of orphaning them.
  const removed = [...existingKeys].filter((key) => !keys.includes(key));
  if (removed.length > 0) {
    await supabase
      .from("contacts")
      .update({ pipeline_stage: keys[0] })
      .eq("workspace_id", session.workspace.id)
      .in("pipeline_stage", removed);

    await supabase
      .from("pipeline_stages")
      .delete()
      .eq("workspace_id", session.workspace.id)
      .in("key", removed);
  }

  const { error } = await supabase.from("pipeline_stages").upsert(
    parsed.data.stages.map((stage, index) => ({
      workspace_id: session.workspace.id,
      key: stage.key,
      label: stage.label,
      color: stage.color,
      is_won: stage.is_won,
      is_lost: stage.is_lost,
      position: index,
    })),
    { onConflict: "workspace_id,key" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "pipeline.updated",
    meta: { stages: keys.length, removed },
  });

  return NextResponse.json({ ok: true, movedFrom: removed });
}
