import { NextResponse } from "next/server";
import { z } from "zod";

import { stopOutreachForContact, terminalStage } from "@/campaigns/stop";
import { logActivity } from "@/lib/activity";
import { domainFromUrl, normalizeEmail } from "@/lib/email";
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
  /**
   * Explicit "stop emailing this person", independent of the stage. Set
   * `suppress` to also block every future campaign.
   */
  stop_outreach: z.boolean().optional(),
  suppress: z.boolean().optional(),
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

  const { id, stop_outreach, suppress, ...patch } = parsed.data;
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

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("contacts")
      .update(patch)
      .eq("id", id)
      .eq("workspace_id", session.workspace.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

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

  // Landing on a won or lost stage ends the sequence automatically — that is
  // the whole point of marking a deal closed. A lost stage also suppresses, so
  // a future campaign cannot re-pitch somebody who already declined.
  let outreach: Awaited<ReturnType<typeof stopOutreachForContact>> | null = null;

  if (patch.pipeline_stage) {
    const terminal = await terminalStage(
      supabase,
      session.workspace.id,
      patch.pipeline_stage,
    );
    if (terminal) {
      outreach = await stopOutreachForContact(supabase, {
        workspaceId: session.workspace.id,
        contactId: id,
        reason: `Moved to ${terminal.label}`,
        suppress: terminal.is_lost,
        suppressionReason: "opted_out",
        actorId: session.userId,
      });
    }
  }

  if (stop_outreach) {
    outreach = await stopOutreachForContact(supabase, {
      workspaceId: session.workspace.id,
      contactId: id,
      reason: suppress ? "Stopped and suppressed by hand" : "Stopped by hand",
      suppress,
      suppressionReason: "manual",
      actorId: session.userId,
    });
  }

  return NextResponse.json({
    ok: true,
    ...(outreach
      ? { stopped_sequences: outreach.stopped, suppressed: outreach.suppressed }
      : {}),
  });
}

const createSchema = z.object({
  email: z.string().email().max(320),
  first_name: z.string().max(120).nullable().optional(),
  last_name: z.string().max(120).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
});

/**
 * Adds one contact by hand. The scraper is the usual source, but a contact you
 * already know does not need a website crawl to get into the list.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const email = normalizeEmail(parsed.data.email);
  const website = parsed.data.website?.trim() || null;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("contacts")
    .upsert(
      {
        workspace_id: session.workspace.id,
        email,
        first_name: parsed.data.first_name ?? null,
        last_name: parsed.data.last_name ?? null,
        phone: parsed.data.phone ?? null,
        website,
        domain: website ? domainFromUrl(website) : (email.split("@")[1] ?? null),
        validation_status: "unknown",
      },
      { onConflict: "workspace_id,email", ignoreDuplicates: true },
    )
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // ignoreDuplicates means an existing address comes back as zero rows, not an
  // error — that is the "already there" case, not a failure to insert.
  const created = (data ?? []) as { id: string }[];
  const first = created[0];
  if (!first) {
    return NextResponse.json(
      { error: "That address is already in this workspace." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, id: first.id });
}

const deleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  /** Suppress as well, so a re-scrape cannot silently re-add and re-email them. */
  suppress: z.boolean().optional(),
});

/**
 * Deletes contacts.
 *
 * Deleting alone does not stop them coming back: the scraper re-adds any
 * address it finds again on the next crawl. `suppress` records the address on
 * the suppression list first, which both blocks future sends and makes a
 * re-scraped copy land as `suppressed` rather than sendable.
 */
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

  const { data: rows } = await supabase
    .from("contacts")
    .select("id, email")
    .eq("workspace_id", session.workspace.id)
    .in("id", parsed.data.ids);

  const contacts = (rows ?? []) as { id: string; email: string }[];
  if (contacts.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0, suppressed: 0 });
  }

  if (parsed.data.suppress) {
    const { suppressEmail } = await import("@/mail/suppressions");
    for (const contact of contacts) {
      await suppressEmail(supabase, {
        workspaceId: session.workspace.id,
        email: contact.email,
        reason: "manual",
        source: "contact-delete",
        actorId: session.userId,
      });
    }
  }

  const { error } = await supabase
    .from("contacts")
    .delete()
    .eq("workspace_id", session.workspace.id)
    .in(
      "id",
      contacts.map((contact) => contact.id),
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "contact.deleted",
    entityType: "contact",
    meta: {
      count: contacts.length,
      suppressed: Boolean(parsed.data.suppress),
    },
  });

  return NextResponse.json({
    ok: true,
    deleted: contacts.length,
    suppressed: parsed.data.suppress ? contacts.length : 0,
  });
}
