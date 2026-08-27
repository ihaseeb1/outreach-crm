import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { logActivity } from "@/lib/activity";
import { sendCampaignContactNow } from "@/campaigns/run";
import type { CampaignContact } from "@/types/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  id: z.string().uuid(), // campaign_contacts.id
  action: z.enum(["send_now", "remove"]),
});

// A contact whose sequence has ended these ways should not be re-sent to.
const TERMINAL = new Set(["replied", "bounced", "unsubscribed", "completed"]);

const OUTCOME_MESSAGE: Record<string, string> = {
  sent: "Sent.",
  completed: "That was the last step — the contact is now complete.",
  skipped:
    "No mailbox was free (resting or at its daily cap). It stays queued and will go on the next tick.",
  stopped: "The send was stopped — the address is suppressed or bounced.",
  failed: "The send failed. Check the mailbox connection and try again.",
};

/**
 * Per-contact controls for the enrolled table (spec §4.2). "Send now" pushes a
 * single contact's current step out immediately (reactivating a stalled one
 * first); "remove" takes the contact out of this campaign without touching the
 * contact record itself. Every action is workspace-scoped and audit-logged.
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
  const { id, action } = parsed.data;
  const supabase = createSupabaseAdminClient();
  const workspaceId = session.workspace.id;

  const { data: row } = await supabase
    .from("campaign_contacts")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "Enrolment not found." }, { status: 404 });
  }
  const entry = row as CampaignContact;

  if (action === "remove") {
    const { error } = await supabase
      .from("campaign_contacts")
      .delete()
      .eq("id", id)
      .eq("workspace_id", workspaceId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await logActivity(supabase, {
      workspaceId,
      actorId: session.userId,
      action: "campaign.contact_removed",
      entityType: "contact",
      entityId: entry.contact_id,
      meta: { campaign_id: entry.campaign_id },
    });
    return NextResponse.json({ ok: true, message: "Removed from this campaign." });
  }

  // send_now
  if (TERMINAL.has(entry.status)) {
    return NextResponse.json(
      {
        error: `This contact is ${entry.status} — there is nothing left to send.`,
      },
      { status: 400 },
    );
  }

  // Reactivate a stalled enrolment and make it due now, so the claim inside
  // sendCampaignContactNow can pick it up.
  await supabase
    .from("campaign_contacts")
    .update({
      status: "active",
      next_send_at: new Date().toISOString(),
      locked_until: null,
      last_error: null,
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId);

  const result = await sendCampaignContactNow(supabase, {
    workspaceId,
    campaignContactId: id,
  });

  await logActivity(supabase, {
    workspaceId,
    actorId: session.userId,
    action: "campaign.contact_send_now",
    entityType: "contact",
    entityId: entry.contact_id,
    meta: { campaign_id: entry.campaign_id, outcome: result.outcome ?? "error" },
  });

  if (!result.ok && result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    ok: result.ok,
    message: OUTCOME_MESSAGE[result.outcome ?? ""] ?? "Done.",
  });
}
