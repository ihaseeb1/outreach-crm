import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const retrySchema = z.object({
  /** Explicit ids, or leave empty and pass a filter to requeue in bulk. */
  ids: z.array(z.string().uuid()).max(1000).optional(),
  status: z.enum(["failed", "skipped_robots", "done"]).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
});

/**
 * Puts websites back in the queue.
 *
 * A 403 or a timeout is usually transient — the site was rate-limiting, or the
 * static fetch tripped a bot check that a later attempt gets past. Requeueing
 * resets the row to `pending` and clears the old error so the next batch picks
 * it up as though it were new.
 */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = retrySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { ids, status, http_status } = parsed.data;
  if (!ids?.length && !status && http_status === undefined) {
    return NextResponse.json(
      { error: "Pass ids, a status, or an http_status to requeue." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("websites")
    .update({ status: "pending", error: null, http_status: null })
    .eq("workspace_id", session.workspace.id);

  if (ids?.length) query = query.in("id", ids);
  if (status) query = query.eq("status", status);
  if (http_status !== undefined) query = query.eq("http_status", http_status);

  // Never yank a row out from under a batch that is mid-scrape.
  query = query.neq("status", "scraping");

  const { data, error } = await query.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const requeued = (data ?? []).length;

  if (requeued > 0) {
    await logActivity(supabase, {
      workspaceId: session.workspace.id,
      actorId: session.userId,
      action: "scrape.requeued",
      entityType: "website",
      meta: { count: requeued, status: status ?? null, http_status: http_status ?? null },
    });
  }

  return NextResponse.json({ ok: true, requeued });
}

const deleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
});

/** Removes websites from the list. Contacts already extracted are kept. */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("websites")
    .delete()
    .eq("workspace_id", session.workspace.id)
    .in("id", parsed.data.ids)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: (data ?? []).length });
}
