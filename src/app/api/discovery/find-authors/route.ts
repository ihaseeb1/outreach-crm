import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  runId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(1000),
});

/**
 * Opts selected discovered sites into author-crawling (Feature 2). The worker
 * then finds their recent guest posts and resolves the authors' destination
 * sites. Idempotent — re-marking a site is a no-op.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("discovered_sites")
    .update({ author_crawl: true })
    .eq("workspace_id", session.workspace.id)
    .eq("run_id", parsed.data.runId)
    .in("id", parsed.data.ids)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: `${error.message} (is migration 0017 applied?)` },
      { status: 500 },
    );
  }

  const marked = (data ?? []).length;
  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "discovery.author_crawl_requested",
    entityType: "discovery_run",
    entityId: parsed.data.runId,
    meta: { marked },
  });

  return NextResponse.json({ ok: true, marked });
}
