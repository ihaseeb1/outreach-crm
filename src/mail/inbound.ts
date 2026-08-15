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
  fetched: number;
  replies: number;
  bounces: number;
  autoReplies: number;
  warmup: number;
  ignored: number;
  error?: string;
}

const FETCH_LIMIT = 25;

export async function pollMailbox(
  supabase: SupabaseClient,
  mailbox: Mailbox,
): Promise<PollResult> {
  const result: PollResult = {
    mailboxId: mailbox.id,
    fetched: 0,
    replies: 0,
    bounces: 0,
    autoReplies: 0,
    warmup: 0,
    ignored: 0,
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

  try {
    const messages = await loaded.provider.fetchInbound({
      sinceUid: mailbox.imap_last_uid,
      limit: FETCH_LIMIT,
    });
    result.fetched = messages.length;

    let highestUid = mailbox.imap_last_uid ?? 0;

    for (const message of messages) {
      highestUid = Math.max(highestUid, message.uid);
      const outcome = await processInbound(supabase, mailbox, message, ownMailboxes);
      switch (outcome) {
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
        default:
          result.ignored += 1;
      }
    }

    await supabase
      .from("mailboxes")
      .update({
        imap_last_uid: highestUid,
        last_polled_at: new Date().toISOString(),
        last_error: null,
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

type InboundOutcome = "reply" | "bounce" | "auto_reply" | "warmup" | "ignored";

async function processInbound(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  message: InboundMessage,
  ownMailboxes: Set<string>,
): Promise<InboundOutcome> {
  const workspaceId = mailbox.workspace_id;
  const fromEmail = normalizeEmail(message.fromEmail);
  if (!fromEmail) return "ignored";

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
    return "warmup";
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

    await insertInbound(supabase, mailbox, message, {
      contactId: bounced ? await contactIdFor(supabase, workspaceId, bounced) : null,
      isBounce: true,
      isAutoReply: false,
    });
    return "bounce";
  }

  // Everything from here on must be tied to outreach we actually sent.
  const link = await linkToOutreach(supabase, workspaceId, fromEmail, message);
  if (!link) return "ignored";

  // --- Auto-responder: recorded for the audit trail, kept out of the inbox,
  //     and explicitly does NOT count as a reply (an out-of-office should not
  //     kill a sequence). ---
  if (kind === "auto_reply") {
    await insertInbound(supabase, mailbox, message, {
      contactId: link.contactId,
      isBounce: false,
      isAutoReply: true,
      campaignId: link.campaignId,
      threadId: link.threadId,
    });
    return "auto_reply";
  }

  // --- A genuine reply. ---
  await insertInbound(supabase, mailbox, message, {
    contactId: link.contactId,
    isBounce: false,
    isAutoReply: false,
    campaignId: link.campaignId,
    threadId: link.threadId,
  });

  // Compliance rule #6: a reply immediately pauses that contact's sequence.
  await markCampaignContacts(supabase, workspaceId, fromEmail, {
    status: "replied",
    replied_at: new Date().toISOString(),
    next_send_at: null,
    paused_reason: "Contact replied",
  });

  if (link.contactId) {
    await supabase
      .from("contacts")
      .update({ pipeline_stage: "replied" })
      .eq("id", link.contactId)
      .eq("pipeline_stage", "contacted");
  }

  await logActivity(supabase, {
    workspaceId,
    action: "mail.reply_received",
    entityType: "contact",
    entityId: link.contactId,
    meta: { from: fromEmail, subject: message.subject },
  });

  return "reply";
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
): Promise<void> {
  // The unique index on (workspace_id, message_id) makes re-polling harmless.
  await supabase.from("messages").upsert(
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
    { onConflict: "workspace_id,message_id", ignoreDuplicates: true },
  );
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
