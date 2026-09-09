import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { normalizeEmail } from "@/lib/email";
import { parseQuote } from "@/deals/parse-quote";
import {
  autoCaptureEnabled,
  buildCaptureNote,
  mergeNote,
  planCapture,
  type DealSnapshot,
} from "@/deals/auto-capture";

/**
 * Reads a publisher's reply and files the numbers on their deal, automatically.
 *
 * Called from the inbound poller the moment a genuine reply is stored. It runs
 * the same rate-card parser the deal form runs when you click "Use this", then
 * either drafts a deal for the publisher (if none exists) or fills in whatever
 * blanks the reply answered on the deal already there — never overwriting a
 * value a person set, never changing the deal's status.
 *
 * Best-effort by contract: it is wrapped in a try/catch at the call site and its
 * own failures are swallowed, because storing the reply and pausing the sequence
 * must never be undone by a problem writing a deal.
 */

export interface CaptureReplyInput {
  workspaceId: string;
  /** The contact who replied, if resolved. Deals are deduped per contact. */
  contactId: string | null;
  fromEmail: string;
  /** The reply body — quoted history is stripped by the parser. */
  replyText: string | null | undefined;
  subject?: string | null;
}

export interface CaptureReplyResult {
  captured: boolean;
  /** "created" a new deal, "updated" an existing one, or a reason it did nothing. */
  outcome: "created" | "updated" | "nothing" | "disabled" | "no-anchor";
  dealId?: string;
  filled?: number;
  prices?: number;
}

let metaColumnPresent = false;

/**
 * Whether migration 0022 (the `deals.meta` column) is applied. Cached true once
 * seen; a false is re-probed so an instance that started before the migration
 * picks it up. Same shape as `dealPlacementReady` for 0012.
 */
async function dealMetaReady(supabase: SupabaseClient): Promise<boolean> {
  if (metaColumnPresent) return true;
  const { error } = await supabase.from("deals").select("meta").limit(1);
  metaColumnPresent = !error;
  return metaColumnPresent;
}

/** Publisher website for the deal: the contact's domain, else the reply's. */
function domainFor(contactDomain: string | null, fromEmail: string): string | null {
  const raw = contactDomain?.trim() || fromEmail.split("@")[1] || "";
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  return cleaned || null;
}

export async function captureDealFromReply(
  supabase: SupabaseClient,
  input: CaptureReplyInput,
): Promise<CaptureReplyResult> {
  const { workspaceId, contactId, fromEmail } = input;
  const text = input.replyText ?? "";
  if (!text.trim()) return { captured: false, outcome: "nothing" };

  // Per-workspace opt-out. Read once here — replies are rare (warmup and noise
  // are filtered long before this runs), so a lookup per reply is nothing.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .maybeSingle();

  if (!autoCaptureEnabled((workspace as { settings?: unknown } | null)?.settings)) {
    return { captured: false, outcome: "disabled" };
  }

  const quote = parseQuote(text);

  // The contact record supplies the deal's domain and lets us find an existing
  // deal to accrete into rather than drafting a new one per reply.
  let contactDomain: string | null = null;
  if (contactId) {
    const { data } = await supabase
      .from("contacts")
      .select("domain")
      .eq("id", contactId)
      .maybeSingle();
    contactDomain = (data as { domain: string | null } | null)?.domain ?? null;
  }

  const domain = domainFor(contactDomain, normalizeEmail(fromEmail));
  if (!domain && !contactId) {
    // Nothing to hang a deal on — no contact and no usable domain.
    return { captured: false, outcome: "no-anchor" };
  }

  // The deal to enrich: the most recent one for this contact, else for this
  // domain. A contact match wins because a hand-entered deal may predate the
  // contact link, and one deal per publisher is what a person expects to see.
  const existing = await findExistingDeal(supabase, workspaceId, contactId, domain);

  const snapshot: DealSnapshot = existing
    ? {
        link_type: existing.link_type,
        placement_type: existing.placement_type,
        tat_days: existing.tat_days,
        da: existing.da,
        dr: existing.dr,
        monthly_traffic: existing.monthly_traffic,
        spam_score: existing.spam_score,
        word_count: existing.word_count,
        content_by: existing.content_by,
        max_links: existing.max_links,
        payment_terms: existing.payment_terms,
        payment_method: existing.payment_method,
        existingNiches: existing.niches,
      }
    : {};

  const plan = planCapture(quote, snapshot);
  if (plan.isEmpty) return { captured: false, outcome: "nothing" };

  const metaReady = await dealMetaReady(supabase);
  const note = buildCaptureNote(plan, quote);

  if (existing) {
    const patch: Record<string, unknown> = {
      ...plan.fields,
      notes: mergeNote(existing.notes, note),
    };
    // conversation_id / contact_id backfilled only if the deal lacks them, so a
    // hand-entered deal gains the links a reply can supply.
    if (!existing.contact_id && contactId) patch.contact_id = contactId;
    if (metaReady) {
      patch.meta = mergeMeta(existing.meta ?? null, plan, "updated");
    }

    await supabase
      .from("deals")
      .update(patch)
      .eq("id", existing.id)
      .eq("workspace_id", workspaceId);

    if (plan.newPrices.length > 0) {
      await insertPrices(supabase, existing.id, plan.newPrices);
    }

    await logActivity(supabase, {
      workspaceId,
      action: "deal.auto_captured",
      entityType: "deal",
      entityId: existing.id,
      meta: {
        domain,
        mode: "updated",
        filled: plan.filledKeys,
        prices: plan.newPrices.length,
        from: fromEmail,
      },
    });

    return {
      captured: true,
      outcome: "updated",
      dealId: existing.id,
      filled: plan.filledKeys.length,
      prices: plan.newPrices.length,
    };
  }

  // No deal yet — draft one, negotiating, so it lands in the pipeline for
  // review. `domain` is not-null on the table, so a deal cannot be drafted
  // without one (a reply almost always yields one from the sender address).
  if (!domain) return { captured: false, outcome: "no-anchor" };

  const conversationId = contactId
    ? await conversationIdFor(supabase, workspaceId, contactId)
    : null;

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    contact_id: contactId,
    conversation_id: conversationId,
    domain,
    status: "negotiating",
    currency: plan.currency ?? "USD",
    notes: note,
    ...plan.fields,
  };
  if (metaReady) payload.meta = mergeMeta(null, plan, "created");

  const { data, error } = await supabase
    .from("deals")
    .insert(payload)
    .select("id")
    .single();

  if (error || !data) {
    // Swallowed by the caller; surfaced only in the return so the poll can note it.
    return { captured: false, outcome: "nothing" };
  }

  const dealId = (data as { id: string }).id;

  if (plan.newPrices.length > 0) {
    await insertPrices(supabase, dealId, plan.newPrices);
  }

  await logActivity(supabase, {
    workspaceId,
    action: "deal.auto_captured",
    entityType: "deal",
    entityId: dealId,
    meta: {
      domain,
      mode: "created",
      filled: plan.filledKeys,
      prices: plan.newPrices.length,
      from: fromEmail,
    },
  });

  return {
    captured: true,
    outcome: "created",
    dealId,
    filled: plan.filledKeys.length,
    prices: plan.newPrices.length,
  };
}

interface ExistingDeal {
  id: string;
  contact_id: string | null;
  notes: string | null;
  meta?: Record<string, unknown> | null;
  niches: string[];
  link_type: string | null;
  placement_type: string | null;
  tat_days: number | null;
  da: number | null;
  dr: number | null;
  monthly_traffic: number | null;
  spam_score: number | null;
  word_count: number | null;
  content_by: string | null;
  max_links: number | null;
  payment_terms: string | null;
  payment_method: string | null;
}

async function findExistingDeal(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string | null,
  domain: string | null,
): Promise<ExistingDeal | null> {
  const columns =
    "id, contact_id, notes, link_type, placement_type, tat_days, da, dr, monthly_traffic, spam_score, word_count, content_by, max_links, payment_terms, payment_method, deal_prices(niche)";

  const run = async (select: string): Promise<Record<string, unknown> | null> => {
    let query = supabase
      .from("deals")
      .select(select)
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(1);
    query = contactId
      ? query.eq("contact_id", contactId)
      : query.eq("domain", domain ?? "");
    const { data } = await query.maybeSingle();
    return (data as Record<string, unknown> | null) ?? null;
  };

  // Try with `meta` (0022 applied); fall back without it so a pre-migration
  // instance still finds and enriches the deal.
  let row = await run(`${columns}, meta`);
  if (row === null) row = await run(columns);
  if (!row) return null;

  const niches = ((row.deal_prices ?? []) as { niche: string }[]).map(
    (price) => price.niche,
  );

  return {
    id: row.id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    niches,
    link_type: (row.link_type as string | null) ?? null,
    placement_type: (row.placement_type as string | null) ?? null,
    tat_days: (row.tat_days as number | null) ?? null,
    da: (row.da as number | null) ?? null,
    dr: (row.dr as number | null) ?? null,
    monthly_traffic: (row.monthly_traffic as number | null) ?? null,
    spam_score: (row.spam_score as number | null) ?? null,
    word_count: (row.word_count as number | null) ?? null,
    content_by: (row.content_by as string | null) ?? null,
    max_links: (row.max_links as number | null) ?? null,
    payment_terms: (row.payment_terms as string | null) ?? null,
    payment_method: (row.payment_method as string | null) ?? null,
  };
}

/** Adds only the niches not already on the deal; existing prices are untouched. */
async function insertPrices(
  supabase: SupabaseClient,
  dealId: string,
  prices: { niche: string; price: number; currency: string }[],
): Promise<void> {
  // The unique (deal_id, niche) index means a race can raise 23505; ignore it,
  // an existing niche is exactly what we did not want to touch.
  await supabase
    .from("deal_prices")
    .upsert(
      prices.map((price) => ({
        deal_id: dealId,
        niche: price.niche,
        price: price.price,
        currency: price.currency,
      })),
      { onConflict: "deal_id,niche", ignoreDuplicates: true },
    );
}

async function conversationIdFor(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Structured provenance, kept small: when, how, and the evidence lines. */
function mergeMeta(
  existing: Record<string, unknown> | null,
  plan: ReturnType<typeof planCapture>,
  mode: "created" | "updated",
): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const prior = (base.auto_capture as Record<string, unknown> | undefined) ?? {};
  const now = new Date().toISOString();
  return {
    ...base,
    auto_capture: {
      source: "reply",
      first_at: (prior.first_at as string | undefined) ?? now,
      last_at: now,
      last_mode: mode,
      filled: plan.filledKeys,
      prices: plan.newPrices.map((p) => p.niche),
      evidence: plan.evidence,
    },
  };
}
