import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(160),
});

const DEFAULT_STEPS = [
  {
    step_number: 1,
    delay_days: 0,
    subject_template: "Quick question about {{domain}}",
    body_template:
      "Hi {{first_name|there}},\n\n" +
      "I came across {{domain}} while researching sites in this space and really liked what you're publishing.\n\n" +
      "I write in a related niche — do you accept guest contributions or paid placements? If so, could you share your rates and turnaround time?\n\n" +
      "Thanks,\n",
    reply_to_thread: false,
  },
  {
    step_number: 2,
    delay_days: 3,
    subject_template: "",
    body_template:
      "Hi {{first_name|there}},\n\n" +
      "Just floating this back to the top of your inbox in case it got buried.\n\n" +
      "Happy to send over topic ideas if that's easier.\n\n" +
      "Thanks,\n",
    reply_to_thread: true,
  },
  {
    step_number: 3,
    delay_days: 5,
    subject_template: "",
    body_template:
      "Hi {{first_name|there}},\n\n" +
      "Last one from me — if it's not a fit, no problem at all, and I won't chase again.\n\n" +
      "If you'd rather I check back later in the year, just say the word.\n\n" +
      "Thanks,\n",
    reply_to_thread: true,
  },
];

/** Creates a campaign pre-loaded with a sensible 3-step sequence. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A campaign name is required." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      workspace_id: session.workspace.id,
      name: parsed.data.name,
      status: "draft",
      created_by: session.userId,
      mailbox_ids: [],
      settings: {
        send_window_start: 9,
        send_window_end: 17,
        send_days: [1, 2, 3, 4, 5],
        timezone: "UTC",
      },
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create campaign." },
      { status: 500 },
    );
  }

  const campaignId = (data as { id: string }).id;

  await supabase.from("sequence_steps").insert(
    DEFAULT_STEPS.map((step) => ({ campaign_id: campaignId, ...step })),
  );

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "campaign.created",
    entityType: "campaign",
    entityId: campaignId,
    meta: { name: parsed.data.name },
  });

  return NextResponse.json({ ok: true, id: campaignId });
}

const patchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160).optional(),
  status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional(),
  mailbox_ids: z.array(z.string().uuid()).optional(),
  settings: z
    .object({
      send_window_start: z.number().int().min(0).max(23).optional(),
      send_window_end: z.number().int().min(1).max(24).optional(),
      send_days: z.array(z.number().int().min(0).max(6)).optional(),
      timezone: z.string().max(64).optional(),
    })
    .optional(),
});

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

  // Activating a campaign is the point of no return, so check the things that
  // would otherwise fail silently on every single contact.
  if (patch.status === "active") {
    const problem = await preflight(supabase, session.workspace.id, id);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  const { error } = await supabase
    .from("campaigns")
    .update(patch)
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (patch.status) {
    await logActivity(supabase, {
      workspaceId: session.workspace.id,
      actorId: session.userId,
      action: `campaign.${patch.status}`,
      entityType: "campaign",
      entityId: id,
    });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("campaigns")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** Everything that must be true before a campaign is allowed to start sending. */
async function preflight(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  workspaceId: string,
  campaignId: string,
): Promise<string | null> {
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("sending_postal_address")
    .eq("id", workspaceId)
    .single();

  const postal = (workspace as { sending_postal_address: string | null } | null)
    ?.sending_postal_address;
  if (!postal || !postal.trim()) {
    return "Add a sending postal address in Settings first — CAN-SPAM requires it in every campaign email.";
  }

  const { count: stepCount } = await supabase
    .from("sequence_steps")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (!stepCount) {
    return "This campaign has no sequence steps yet.";
  }

  const { count: mailboxCount } = await supabase
    .from("mailboxes")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .neq("health_status", "paused");
  if (!mailboxCount) {
    return "No active mailbox is available to send from.";
  }

  const { count: contactCount } = await supabase
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (!contactCount) {
    return "Add some contacts to this campaign first.";
  }

  return null;
}
