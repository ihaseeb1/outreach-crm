import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { archiveColumnExists } from "@/lib/contact-archive";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  /** true = archive (hide + stop sequences); false = restore to the list. */
  archived: z.boolean(),
});

/**
 * Archive / restore contacts (spec §8).
 *
 * Archiving is the safe alternative to DELETE: the record and its whole history
 * stay, the contact just drops out of the working list. Archiving also ends any
 * live sequence for that contact in one batched update — an archived address
 * must not keep receiving mail — mirroring stopOutreachForContact's semantics
 * (pending/active → completed) without suppressing, so it can be restored later.
 * Restoring only un-hides; it does not re-start the stopped sequences.
 */
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

  if (!(await archiveColumnExists(supabase))) {
    return NextResponse.json(
      { error: "Archiving is not enabled yet — apply migration 0011 in Supabase." },
      { status: 409 },
    );
  }

  const { ids, archived } = parsed.data;
  const workspaceId = session.workspace.id;

  // Scope to the workspace's own contacts before touching anything.
  const { data: rows } = await supabase
    .from("contacts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  const contactIds = ((rows ?? []) as { id: string }[]).map((row) => row.id);
  if (contactIds.length === 0) {
    return NextResponse.json({ ok: true, archived: 0, sequences_stopped: 0 });
  }

  const { error } = await supabase
    .from("contacts")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("workspace_id", workspaceId)
    .in("id", contactIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // End live sequences for the archived contacts in one shot — same effect as
  // stopping each by hand, but as a set operation so a 500-contact archive is a
  // single query rather than 500.
  let sequencesStopped = 0;
  if (archived) {
    const { data: ended } = await supabase
      .from("campaign_contacts")
      .update({
        status: "completed",
        next_send_at: null,
        locked_until: null,
        paused_reason: "Contact archived",
      })
      .eq("workspace_id", workspaceId)
      .in("contact_id", contactIds)
      .in("status", ["pending", "active"])
      .select("id");
    sequencesStopped = (ended ?? []).length;
  }

  await logActivity(supabase, {
    workspaceId,
    actorId: session.userId,
    action: archived ? "contact.archived" : "contact.restored",
    entityType: "contact",
    meta: { count: contactIds.length, sequences_stopped: sequencesStopped },
  });

  return NextResponse.json({
    ok: true,
    archived: contactIds.length,
    sequences_stopped: sequencesStopped,
  });
}
