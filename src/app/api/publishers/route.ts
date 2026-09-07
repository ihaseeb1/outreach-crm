import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deleteSchema = z.object({
  /** Specific active_author ids to remove, or set `all` to clear the history. */
  ids: z.array(z.string().uuid()).max(2000).optional(),
  all: z.boolean().optional(),
});

/**
 * Removes active-publisher (guest author) rows. Contacts already promoted to
 * the contacts table via "Add to contacts" are untouched — this only clears the
 * discovered-author history so the list stays workable. Workspace-scoped.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { ids, all } = parsed.data;
  if (!all && !ids?.length) {
    return NextResponse.json(
      { error: "Pass author ids, or all: true to clear history." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("active_authors")
    .delete()
    .eq("workspace_id", session.workspace.id);
  if (ids?.length) query = query.in("id", ids);

  const { data, error } = await query.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const deleted = (data ?? []).length;
  if (deleted > 0) {
    await logActivity(supabase, {
      workspaceId: session.workspace.id,
      actorId: session.userId,
      action: "publishers.authors_deleted",
      entityType: "active_author",
      meta: { count: deleted, all: Boolean(all) },
    });
  }

  return NextResponse.json({ ok: true, deleted });
}
