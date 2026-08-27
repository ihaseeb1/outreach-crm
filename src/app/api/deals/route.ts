import { NextResponse } from "next/server";
import { z } from "zod";

import { dealStatusStops, stopOutreachForContact } from "@/campaigns/stop";
import { logActivity } from "@/lib/activity";
import { safeEqual } from "@/lib/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { starConversationInMailbox, type StarOutcome } from "@/mail/star";
import { getSession } from "@/lib/workspace";
import { toApiShape } from "@/deals/export";
import {
  contactEmailMap,
  dealMailboxMap,
  filterByMailbox,
  loadDeals,
  parseDealFilters,
} from "@/deals/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — read-only deal feed for an external portal.
 *
 * Authenticated by the workspace API key (`Authorization: Bearer <key>`, or
 * `?api_key=`), NOT by a session, so a server elsewhere can pull it. Read-only
 * by construction: this handler never writes.
 *
 * A signed-in user without a key gets their own workspace's deals, so the same
 * endpoint powers the UI.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const providedKey = bearer || url.searchParams.get("api_key") || "";

  let workspaceId: string | null = null;
  let supabase = createSupabaseAdminClient();

  if (providedKey) {
    const { data } = await supabase
      .from("workspaces")
      .select("id, api_key")
      .eq("api_key", providedKey)
      .maybeSingle();

    const workspace = data as { id: string; api_key: string } | null;
    // Compared in constant time even though the lookup already matched, so a
    // timing signal cannot be used to probe keys.
    if (workspace && safeEqual(workspace.api_key, providedKey)) {
      workspaceId = workspace.id;
    }
  } else {
    const session = await getSession();
    if (session) {
      workspaceId = session.workspace.id;
      supabase = (await createSupabaseServerClient()) as unknown as ReturnType<
        typeof createSupabaseAdminClient
      >;
    }
  }

  if (!workspaceId) {
    return NextResponse.json(
      { error: "Unauthorized. Send the workspace API key as a bearer token." },
      { status: 401 },
    );
  }

  const filters = parseDealFilters(url.searchParams);
  const loaded = await loadDeals(supabase, workspaceId, filters);

  const mailboxByDeal = await dealMailboxMap(supabase, loaded);
  const deals = filterByMailbox(loaded, mailboxByDeal, filters.mailboxId);

  const [emails, { data: mailboxRows }] = await Promise.all([
    contactEmailMap(supabase, deals),
    supabase.from("mailboxes").select("id, email").eq("workspace_id", workspaceId),
  ]);

  const mailboxEmails = new Map(
    ((mailboxRows ?? []) as { id: string; email: string }[]).map((row) => [
      row.id,
      row.email,
    ]),
  );

  return NextResponse.json({
    count: deals.length,
    filters,
    deals: deals.map((deal) =>
      toApiShape(deal, deal.contact_id ? emails.get(deal.contact_id) : undefined, {
        mailboxEmail: mailboxEmails.get(mailboxByDeal.get(deal.id) ?? "") ?? null,
      }),
    ),
  });
}

const priceSchema = z.object({
  niche: z.string().min(1).max(60),
  price: z.number().min(0).max(1_000_000),
  currency: z.string().min(1).max(8).optional(),
});

const dealSchema = z.object({
  id: z.string().uuid().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
  domain: z.string().min(1).max(255),
  link_type: z.string().max(60).nullable().optional(),
  placement_type: z.string().max(60).nullable().optional(),
  tat_days: z.number().int().min(0).max(365).nullable().optional(),
  da: z.number().int().min(0).max(100).nullable().optional(),
  dr: z.number().int().min(0).max(100).nullable().optional(),
  monthly_traffic: z.number().int().min(0).nullable().optional(),
  spam_score: z.number().int().min(0).max(100).nullable().optional(),
  word_count: z.number().int().min(0).max(100_000).nullable().optional(),
  content_by: z.string().max(60).nullable().optional(),
  max_links: z.number().int().min(0).max(100).nullable().optional(),
  payment_terms: z.string().max(500).nullable().optional(),
  payment_method: z.string().max(120).nullable().optional(),
  // Link placement (spec §9). Only sent once migration 0012 is applied; the
  // verifier fills in link_status/checked/etc., so those are not accepted here.
  placed_url: z.string().max(2000).nullable().optional(),
  target_url: z.string().max(2000).nullable().optional(),
  anchor_text: z.string().max(300).nullable().optional(),
  currency: z.string().min(1).max(8).default("USD"),
  status: z
    .enum(["negotiating", "agreed", "ordered", "live", "rejected"])
    .default("negotiating"),
  notes: z.string().max(10_000).nullable().optional(),
  prices: z.array(priceSchema).max(40).default([]),
});

/** Creates or updates a deal together with its per-niche price list. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = dealSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const { id, prices, ...fields } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const payload = {
    ...fields,
    domain: fields.domain.trim().toLowerCase().replace(/^www\./, ""),
    workspace_id: session.workspace.id,
    created_by: session.userId,
  };

  const { data, error } = id
    ? await supabase
        .from("deals")
        .update(payload)
        .eq("id", id)
        .eq("workspace_id", session.workspace.id)
        .select("id")
        .single()
    : await supabase.from("deals").insert(payload).select("id").single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not save the deal." },
      { status: 500 },
    );
  }

  const dealId = (data as { id: string }).id;

  // Replace the price list wholesale — it is edited as one block in the form.
  await supabase.from("deal_prices").delete().eq("deal_id", dealId);
  const cleanPrices = prices.filter((price) => price.niche.trim());
  if (cleanPrices.length > 0) {
    await supabase.from("deal_prices").insert(
      cleanPrices.map((price) => ({
        deal_id: dealId,
        niche: price.niche.trim(),
        price: price.price,
        currency: price.currency ?? fields.currency,
      })),
    );
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: id ? "deal.updated" : "deal.created",
    entityType: "deal",
    entityId: dealId,
    meta: { domain: payload.domain, status: fields.status, prices: cleanPrices.length },
  });

  // Logging a deal should leave a mark where the user actually reads mail, so
  // the thread is starred in the mailbox it arrived in. The admin client is
  // required: encrypted_credentials is revoked from the authenticated role, and
  // opening the mailbox needs them.
  //
  // Best-effort — the deal is already saved, and a slow or offline mailbox must
  // not turn a successful save into an error. The outcome is reported back so
  // the form can say what happened instead of pretending it worked.
  let starred: StarOutcome | null = null;

  // The contact this deal is about. On an *edit* the client often omits
  // contact_id (it only sends changed fields), so fall back to whatever the
  // saved deal already carries — otherwise marking a deal "agreed" from the
  // deals list would never stop the follow-up sequence, and the publisher you
  // just agreed terms with keeps getting chased.
  const effectiveContactId =
    fields.contact_id ??
    ((
      await supabase
        .from("deals")
        .select("contact_id")
        .eq("id", dealId)
        .eq("workspace_id", session.workspace.id)
        .maybeSingle()
    ).data as { contact_id: string | null } | null)?.contact_id ??
    null;

  const conversationId =
    fields.conversation_id ??
    (effectiveContactId
      ? ((
          await supabase
            .from("conversations")
            .select("id")
            .eq("contact_id", effectiveContactId)
            .eq("workspace_id", session.workspace.id)
            // A contact can now have several threads (one per pitch), so pick the
            // most recent rather than assuming exactly one — maybeSingle() would
            // error on more than one row.
            .order("last_message_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        ).data as { id: string } | null)?.id ?? null
      : null);

  if (conversationId) {
    starred = await starConversationInMailbox(createSupabaseAdminClient(), {
      workspaceId: session.workspace.id,
      conversationId,
    });
  }

  // Closing a deal has to stop the follow-ups, otherwise the sequence keeps
  // chasing somebody you have already agreed terms with.
  const stop = effectiveContactId ? dealStatusStops(fields.status) : null;
  let stoppedSequences = 0;

  if (stop && effectiveContactId) {
    const outcome = await stopOutreachForContact(supabase, {
      workspaceId: session.workspace.id,
      contactId: effectiveContactId,
      reason: stop.reason,
      suppress: stop.suppress,
      suppressionReason: stop.suppressionReason,
      actorId: session.userId,
    });
    stoppedSequences = outcome.stopped;
  }

  return NextResponse.json({
    ok: true,
    id: dealId,
    stopped_sequences: stoppedSequences,
    starred: starred?.ok ? { folder: starred.folder, mailbox: starred.email } : null,
    star_error: starred && !starred.ok ? starred.reason : null,
  });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const supabase = await createSupabaseServerClient();

  // Read the domain before deleting it — the activity log is the only trace a
  // removed rate card leaves, and "deal deleted, id 8f3c…" tells nobody which
  // publisher went missing. deal_prices cascades with the row (migration 0005).
  const { data: existing } = await supabase
    .from("deals")
    .select("domain, status")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Deal not found." }, { status: 404 });
  }

  const { error } = await supabase
    .from("deals")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "deal.deleted",
    entityType: "deal",
    entityId: id,
    meta: existing as Record<string, unknown>,
  });

  return NextResponse.json({ ok: true });
}
