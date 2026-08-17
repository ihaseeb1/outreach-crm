import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { normalizeEmail } from "@/lib/email";
import { classifyInbound, WARMUP_HEADER } from "@/mail/inbound-classify";
import { loadMailboxProvider } from "@/mail/providers";
import { suppressEmail } from "@/mail/suppressions";
import type { InboundMessage } from "@/mail/providers/types";
import type { Mailbox } from "@/types/db";

/**
 * IMAP poller.
 *
 * Connect → fetch anything newer than the last UID → process → disconnect.
 * No persistent connections, so it runs happily inside a serverless function.
 *
 * What lands in the unified inbox is tightly controlled: only genuine replies
 * from people we actually emailed. Warmup traffic, bounces, autoresponders, and
 * the mailbox owner's ordinary personal mail are all filtered out here.
 */

export interface PollResult {
  mailboxId: string;
  mailboxEmail: string;
  fetched: number;
  replies: number;
  bounces: number;
  autoReplies: number;
  warmup: number;
  ignored: number;
  /** Already stored by an earlier poll — the normal outcome of a rescan. */
  duplicates: number;
  /** Fetched but not storable. The UID checkpoint stops here so they come back. */
  failed: number;
  error?: string;
}

const FETCH_LIMIT = 25;

export async function pollMailbox(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  options: {
    /**
     * Re-read this many UIDs below the stored checkpoint. Recovery only: mail
     * that was fetched but never stored is otherwise unreachable, because the
     * checkpoint has already moved past it.
     */
    rescanUids?: number;
    fetchLimit?: number;
  } = {},
): Promise<PollResult> {
  const result: PollResult = {
    mailboxId: mailbox.id,
    mailboxEmail: mailbox.email,
    fetched: 0,
    replies: 0,
    bounces: 0,
    autoReplies: 0,
    warmup: 0,
    ignored: 0,
    duplicates: 0,
    failed: 0,
  };

  const loaded = await loadMailboxProvider(supabase, mailbox.id);
  if (!loaded) {
    result.error = "No stored credentials.";
    return result;
  }

  const ownMailboxes = await workspaceMailboxAddresses(
    supabase,
    mailbox.workspace_id,
  );

  const checkpoint = mailbox.imap_last_uid ?? 0;
  const rescan = Math.max(0, options.rescanUids ?? 0);

  try {
    const messages = await loaded.provider.fetchInbound({
      sinceUid: Math.max(0, checkpoint - rescan),
      limit: options.fetchLimit ?? FETCH_LIMIT,
    });
    result.fetched = messages.length;

    // Ascending, because the checkpoint below is "everything up to here is
    // stored" — it can only be trusted if the messages are walked in order.
    const ordered = [...messages].sort((a, b) => a.uid - b.uid);

    // Never advanced past a message we failed to store. That is exactly how the
    // first real reply was lost: the insert errored, nobody looked at the error,
    // and the checkpoint moved on regardless, so no later poll would ever see
    // that mail again.
    let highestUid = checkpoint;

    for (const message of ordered) {
      const outcome = await processInbound(supabase, mailbox, message, ownMailboxes);

      if (outcome.kind === "failed") {
        result.failed += 1;
        result.error = `Could not store inbound mail (uid ${message.uid}): ${outcome.error}`;
        break;
      }

      highestUid = Math.max(highestUid, message.uid);

      switch (outcome.kind) {
        case "reply":
          result.replies += 1;
          break;
        case "bounce":
          result.bounces += 1;
          break;
        case "auto_reply":
          result.autoReplies += 1;
          break;
        case "warmup":
          result.warmup += 1;
          break;
        case "duplicate":
          result.duplicates += 1;
          break;
        default:
          result.ignored += 1;
      }
    }

    await supabase
      .from("mailboxes")
      .update({
        imap_last_uid: highestUid,
        last_polled_at: new Date().toISOString(),
        last_error: result.error ? `Inbound: ${result.error}` : null,
      })
      .eq("id", mailbox.id);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    await supabase
      .from("mailboxes")
      .update({
        last_polled_at: new Date().toISOString(),
        last_error: `IMAP: ${result.error}`,
      })
      .eq("id", mailbox.id);
  } finally {
    await loaded.provider.close().catch(() => undefined);
  }

  return result;
}

type InboundOutcome =
  | { kind: "reply" | "bounce" | "auto_reply" | "warmup" | "ignored" | "duplicate" }
  | { kind: "failed"; error: string };

async function processInbound(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  message: InboundMessage,
  ownMailboxes: Set<string>,
): Promise<InboundOutcome> {
  const workspaceId = mailbox.workspace_id;
  const fromEmail = normalizeEmail(message.fromEmail);
  if (!fromEmail) return { kind: "ignored" };

  // Stored already? Then stop before anything with a side effect. Re-marking a
  // contact as replied is harmless; re-counting a warmup reply and re-logging
  // activity are not, and a rescan walks over old mail by design.
  if (await alreadyStored(supabase, workspaceId, message.messageId)) {
    return { kind: "duplicate" };
  }

  // The provider already ran the classifier, but re-running it here is what
  // brings the workspace's own mailbox addresses into the decision.
  const classification = classifyInbound({
    fromEmail,
    subject: message.subject ?? "",
    text: message.text,
    headers: message.isBounce ? { "content-type": "multipart/report" } : {},
    ownMailboxes,
  });

  const kind = message.isBounce
    ? "bounce"
    : classification.kind === "warmup"
      ? "warmup"
      : message.isAutoReply
        ? "auto_reply"
        : classification.kind;

  // --- Warmup: tracked by the warmup engine, never shown in the inbox. ---
  if (kind === "warmup") {
    await recordWarmupReply(supabase, workspaceId, message);
    return { kind: "warmup" };
  }

  // --- Bounce: suppress permanently failing addresses. ---
  if (kind === "bounce") {
    const bounced = message.bouncedRecipient
      ? normalizeEmail(message.bouncedRecipient)
      : null;

    if (bounced && message.bounceType === "hard") {
      await suppressEmail(supabase, {
        workspaceId,
        email: bounced,
        reason: "hard_bounce",
        source: `imap:${mailbox.email}`,
        meta: { subject: message.subject },
      });
      await markCampaignContacts(supabase, workspaceId, bounced, {
        status: "bounced",
        paused_reason: "Hard bounce",
      });
    }

    const stored = await insertInbound(supabase, mailbox, message, {
      contactId: bounced ? await contactIdFor(supabase, workspaceId, bounced) : null,
      isBounce: true,
      isAutoReply: false,
    });
    if (stored.error) return { kind: "failed", error: stored.error };
    return { kind: "bounce" };
  }

  // Everything from here on must be tied to outreach we actually sent.
  const link = await linkToOutreach(supabase, workspaceId, fromEmail, message);
  if (!link) return { kind: "ignored" };

  // --- Auto-responder: recorded for the audit trail, kept out of the inbox,
  //     and explicitly does NOT count as a reply (an out-of-office should not
  //     kill a sequence). ---
  if (kind === "auto_reply") {
    const stored = await insertInbound(supabase, mailbox, message, {
      contactId: link.contactId,
      isBounce: false,
      isAutoReply: true,
      campaignId: link.campaignId,
      threadId: link.threadId,
    });
    if (stored.error) return { kind: "failed", error: stored.error };
    return { kind: "auto_reply" };
  }

  // --- A genuine reply. ---
  //
  // Storing it comes first and everything else is conditional on it. A campaign
  // that counts a reply the inbox cannot show is worse than one that counts
  // nothing: it says a publisher answered and gives no way to read what they
  // said. That mismatch is precisely what this guard exists to prevent.
  //
  // The contact is resolved by address when threading cannot supply one, so the
  // message and the campaign counter can never disagree about who wrote in: a
  // reply stored without a contact id gets no conversation (the trigger needs
  // one) and so would never appear in the inbox either.
  const contactId =
    link.contactId ?? (await contactIdFor(supabase, workspaceId, fromEmail));

  const stored = await insertInbound(supabase, mailbox, message, {
    contactId,
    isBounce: false,
    isAutoReply: false,
    campaignId: link.campaignId,
    threadId: link.threadId,
  });
  if (stored.error) return { kind: "failed", error: stored.error };

  // Compliance rule #6: a reply immediately pauses that contact's sequence.
  await markCampaignContacts(supabase, workspaceId, fromEmail, {
    status: "replied",
    replied_at: new Date().toISOString(),
    next_send_at: null,
    paused_reason: "Contact replied",
  });

  if (contactId) {
    await supabase
      .from("contacts")
      .update({ pipeline_stage: "replied" })
      .eq("id", contactId)
      .eq("pipeline_stage", "contacted");
  }

  await logActivity(supabase, {
    workspaceId,
    action: "mail.reply_received",
    entityType: "contact",
    entityId: contactId,
    meta: { from: fromEmail, subject: message.subject },
  });

  return { kind: "reply" };
}

interface OutreachLink {
  contactId: string | null;
  campaignId: string | null;
  threadId: string | null;
}

/**
 * Ties an inbound mail back to something we sent — first by threading headers,
 * then by sender address against a contact we have already emailed.
 *
 * If neither matches, the mail is somebody's ordinary personal correspondence
 * and is dropped without being stored.
 */
async function linkToOutreach(
  supabase: SupabaseClient,
  workspaceId: string,
  fromEmail: string,
  message: InboundMessage,
): Promise<OutreachLink | null> {
  const references = [message.inReplyTo, ...message.references].filter(
    (value): value is string => Boolean(value),
  );

  if (references.length > 0) {
    const { data } = await supabase
      .from("messages")
      .select("contact_id, campaign_id, thread_id")
      .eq("workspace_id", workspaceId)
      .eq("direction", "outbound")
      .in("message_id", references)
      .limit(1)
      .maybeSingle();

    if (data) {
      const row = data as {
        contact_id: string | null;
        campaign_id: string | null;
        thread_id: string | null;
      };
      return {
        contactId: row.contact_id,
        campaignId: row.campaign_id,
        threadId: row.thread_id,
      };
    }
  }

  // Reply from a different address on the same thread is common, so also match
  // on "did we ever email this address?".
  const { data: prior } = await supabase
    .from("messages")
    .select("contact_id, campaign_id, thread_id")
    .eq("workspace_id", workspaceId)
    .eq("direction", "outbound")
    .eq("to_email", fromEmail)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (prior) {
    const row = prior as {
      contact_id: string | null;
      campaign_id: string | null;
      thread_id: string | null;
    };
    return {
      contactId: row.contact_id,
      campaignId: row.campaign_id,
      threadId: row.thread_id,
    };
  }

  return null;
}

async function insertInbound(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  message: InboundMessage,
  options: {
    contactId: string | null;
    isBounce: boolean;
    isAutoReply: boolean;
    campaignId?: string | null;
    threadId?: string | null;
  },
): Promise<{ error?: string }> {
  // A plain insert, deliberately.
  //
  // This was an upsert with `onConflict: "workspace_id,message_id"`, and it
  // never once succeeded. That unique index is *partial*
  // (`where direction = 'inbound' and message_id is not null`), and Postgres
  // cannot infer a partial index from a bare `ON CONFLICT (cols)` — it needs the
  // predicate too, which PostgREST has no way to send. So every single inbound
  // message came back as 42P10, the error was never read, and the poller carried
  // on reporting replies it had not stored.
  //
  // Duplicates are handled by the same index raising 23505, which is caught
  // below, and by the check in processInbound before any of this runs.
  const { error } = await supabase.from("messages").insert(
    {
      workspace_id: mailbox.workspace_id,
      campaign_id: options.campaignId ?? null,
      contact_id: options.contactId,
      mailbox_id: mailbox.id,
      direction: "inbound",
      from_email: message.fromEmail,
      to_email: message.toEmail ?? mailbox.email,
      subject: message.subject,
      body: message.text,
      body_html: message.html,
      message_id: message.messageId,
      in_reply_to: message.inReplyTo,
      thread_id: options.threadId ?? message.messageId,
      status: options.isBounce ? "bounced" : "received",
      is_bounce: options.isBounce,
      is_auto_reply: options.isAutoReply,
      received_at: message.receivedAt,
      meta: { uid: message.uid, from_name: message.fromName },
    },
  );

  if (!error) return {};
  // Someone else stored it between the check and here. Not a failure.
  if (error.code === "23505") return {};
  return { error: error.message };
}

/**
 * Has this message already been stored? Keyed on Message-ID, the same key the
 * unique index uses.
 *
 * Mail with no Message-ID is treated as new every time — rare, and storing a
 * duplicate is a far smaller problem than dropping a real reply.
 */
async function alreadyStored(
  supabase: SupabaseClient,
  workspaceId: string,
  messageId: string | null,
): Promise<boolean> {
  if (!messageId) return false;

  const { data } = await supabase
    .from("messages")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("direction", "inbound")
    .eq("message_id", messageId)
    .limit(1)
    .maybeSingle();

  return Boolean(data);
}

async function markCampaignContacts(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const contactId = await contactIdFor(supabase, workspaceId, email);
  if (!contactId) return;

  await supabase
    .from("campaign_contacts")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "active"]);
}

async function contactIdFor(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("contacts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function workspaceMailboxAddresses(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("mailboxes")
    .select("email")
    .eq("workspace_id", workspaceId);
  return new Set(
    ((data ?? []) as { email: string }[]).map((row) => normalizeEmail(row.email)),
  );
}

/**
 * Warmup replies are counted, not stored as conversations. Phase 4 fills in the
 * warmup_messages bookkeeping; until then this is a deliberate no-op so warmup
 * mail simply never reaches the inbox.
 */
async function recordWarmupReply(
  supabase: SupabaseClient,
  workspaceId: string,
  message: InboundMessage,
): Promise<void> {
  const { recordWarmupInbound } = await import("@/warmup/inbound");
  await recordWarmupInbound(supabase, workspaceId, {
    fromEmail: normalizeEmail(message.fromEmail),
    subject: message.subject ?? "",
    inReplyTo: message.inReplyTo,
    references: message.references,
    warmupToken: null,
  });
}

export { WARMUP_HEADER };
