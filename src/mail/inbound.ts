import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { normalizeEmail } from "@/lib/email";
import { classifyInbound, WARMUP_HEADER } from "@/mail/inbound-classify";
import { loadMailboxProvider } from "@/mail/providers";
import {
  decideInbound,
  referencedMessageIds,
  senderAddresses,
  type PrefilterContext,
} from "@/mail/prefilter";
import { suppressEmail } from "@/mail/suppressions";
import type { InboundHeader, InboundMessage } from "@/mail/providers/types";
import type { Mailbox } from "@/types/db";

/**
 * IMAP poller.
 *
 * Connect → list envelopes above the last UID → download only the ones worth
 * storing → process → disconnect. No persistent connections, so it runs happily
 * inside a serverless function.
 *
 * The two phases matter. Downloading every message in full and deciding
 * afterwards is what made a poll take longer than the function was allowed to
 * live: a personal Gmail account is mostly newsletters and receipts, none of
 * which this app stores, and each one was being pulled down in full anyway.
 *
 * What lands in the unified inbox is tightly controlled: only genuine replies
 * from people we actually emailed. Warmup traffic, bounces, autoresponders, and
 * the mailbox owner's ordinary personal mail are all filtered out here.
 */

export interface PollResult {
  mailboxId: string;
  mailboxEmail: string;
  /** Envelopes looked at. */
  examined: number;
  /** Messages actually downloaded in full. */
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

/** Full messages downloaded per poll. */
const FETCH_LIMIT = 25;

/**
 * Envelopes listed per poll. An order of magnitude above the fetch limit
 * because envelopes are cheap and skipping past a hundred newsletters to reach
 * one reply must not take a hundred polls.
 */
const HEADER_LIMIT = 300;

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
    headerLimit?: number;
    /**
     * Aborted when the caller has stopped waiting. The provider is torn down
     * immediately rather than being left holding an IMAP connection nobody is
     * reading — which is how one slow mailbox used to poison the next few.
     */
    signal?: AbortSignal;
  } = {},
): Promise<PollResult> {
  const result: PollResult = {
    mailboxId: mailbox.id,
    mailboxEmail: mailbox.email,
    examined: 0,
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

  const abort = () => {
    void loaded.provider.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  const ownMailboxes = await workspaceMailboxAddresses(
    supabase,
    mailbox.workspace_id,
  );

  const checkpoint = mailbox.imap_last_uid ?? 0;
  const rescan = Math.max(0, options.rescanUids ?? 0);

  try {
    // Ordered ascending everywhere below, because the checkpoint means
    // "everything up to here is dealt with" — it can only be trusted if the
    // messages are walked in order.
    let ordered: InboundHeader[] = [];
    const verdicts = new Map<number, ReturnType<typeof decideInbound>>();

    const { messages } = await loaded.provider.fetchInboundSelective(
      {
        sinceUid: Math.max(0, checkpoint - rescan),
        limit: options.headerLimit ?? HEADER_LIMIT,
      },
      async (headers) => {
        ordered = [...headers].sort((a, b) => a.uid - b.uid);

        const context = await prefilterContext(
          supabase,
          mailbox.workspace_id,
          ordered,
          ownMailboxes,
        );

        for (const header of ordered) {
          verdicts.set(header.uid, decideInbound(header, context));
        }

        // Only what the prefilter kept, and only as many as the budget allows.
        // The rest keep their place in the queue: the checkpoint stops at the
        // first one left behind, so the next poll starts exactly there.
        return ordered
          .filter((header) => verdicts.get(header.uid) === "fetch")
          .slice(0, options.fetchLimit ?? FETCH_LIMIT)
          .map((header) => header.uid);
      },
    );

    result.examined = ordered.length;

    const bodies = new Map(messages.map((message) => [message.uid, message]));
    result.fetched = bodies.size;

    // Never advanced past a message we failed to store. That is exactly how the
    // first real reply was lost: the insert errored, nobody looked at the error,
    // and the checkpoint moved on regardless, so no later poll would ever see
    // that mail again.
    let highestUid = checkpoint;

    for (const header of ordered) {
      const verdict = verdicts.get(header.uid);

      if (verdict === "duplicate") {
        result.duplicates += 1;
        highestUid = Math.max(highestUid, header.uid);
        continue;
      }

      if (verdict === "ignored") {
        result.ignored += 1;
        highestUid = Math.max(highestUid, header.uid);
        continue;
      }

      if (verdict === "warmup") {
        // Counted from the envelope. Warmup mail is never stored, and every
        // field the counter reads — sender, subject, threading — is already
        // here, so there is nothing to download.
        await recordWarmupReply(supabase, mailbox.workspace_id, header);
        result.warmup += 1;
        highestUid = Math.max(highestUid, header.uid);
        continue;
      }

      const message = bodies.get(header.uid);
      if (!message) {
        // Wanted but not downloaded — the fetch budget ran out, or the server
        // did not return it. Stop here rather than skipping it: the checkpoint
        // must not move past mail that has never been read.
        break;
      }

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
    options.signal?.removeEventListener("abort", abort);
    await loaded.provider.close().catch(() => undefined);
  }

  return result;
}

/**
 * Everything the prefilter needs, in three queries rather than three per
 * message.
 *
 * Asking the database once per envelope is what the old poller did implicitly,
 * inside `processInbound`, and at a few hundred envelopes that alone is slower
 * than the IMAP fetch it was meant to be cheaper than.
 */
async function prefilterContext(
  supabase: SupabaseClient,
  workspaceId: string,
  headers: InboundHeader[],
  ownMailboxes: Set<string>,
): Promise<PrefilterContext> {
  const context: PrefilterContext = {
    ownMailboxes,
    storedMessageIds: new Set<string>(),
    outreachRecipients: new Set<string>(),
    outboundMessageIds: new Set<string>(),
  };

  if (headers.length === 0) return context;

  const incomingIds = headers
    .map((header) => header.messageId)
    .filter((value): value is string => Boolean(value));
  const references = referencedMessageIds(headers);
  const senders = senderAddresses(headers);

  const [stored, threaded, recipients] = await Promise.all([
    incomingIds.length > 0
      ? supabase
          .from("messages")
          .select("message_id")
          .eq("workspace_id", workspaceId)
          .eq("direction", "inbound")
          .in("message_id", incomingIds)
      : Promise.resolve({ data: [] }),
    references.length > 0
      ? supabase
          .from("messages")
          .select("message_id")
          .eq("workspace_id", workspaceId)
          .eq("direction", "outbound")
          .in("message_id", references)
      : Promise.resolve({ data: [] }),
    senders.length > 0
      ? supabase
          .from("messages")
          .select("to_email")
          .eq("workspace_id", workspaceId)
          .eq("direction", "outbound")
          .in("to_email", senders)
      : Promise.resolve({ data: [] }),
  ]);

  for (const row of (stored.data ?? []) as { message_id: string | null }[]) {
    if (row.message_id) context.storedMessageIds.add(row.message_id);
  }
  for (const row of (threaded.data ?? []) as { message_id: string | null }[]) {
    if (row.message_id) context.outboundMessageIds.add(row.message_id);
  }
  for (const row of (recipients.data ?? []) as { to_email: string | null }[]) {
    if (row.to_email) context.outreachRecipients.add(normalizeEmail(row.to_email));
  }

  return context;
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

  // A reply also retires the address from the cold-sending pool for good: it is
  // added to the global suppression list so no *future* campaign re-emails
  // someone who already answered. Pausing the current sequence only stopped this
  // campaign; enrolling the same person in a new one would otherwise cold-mail
  // them again. suppressEmail refuses your own mailboxes and is idempotent, so a
  // warmup reply or a second reply is a harmless no-op. Best-effort and last, so
  // that storing the reply and pausing the sequence above can never be affected
  // by it — and if migration 0020 (the 'replied' reason) is not yet applied the
  // insert simply no-ops until it is.
  await suppressEmail(supabase, {
    workspaceId,
    email: fromEmail,
    reason: "replied",
    source: `imap:${mailbox.email}`,
    meta: { subject: message.subject, auto: true },
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

  // Read the rate card out of the reply and file it on the publisher's deal —
  // the same parse the deal form runs when you click "Use this", now automatic.
  // Strictly best-effort: a failure writing a deal must never undo storing the
  // reply or pausing the sequence above, so any error is swallowed here.
  try {
    const { captureDealFromReply } = await import("@/deals/capture-reply");
    await captureDealFromReply(supabase, {
      workspaceId,
      contactId,
      fromEmail,
      replyText: message.text,
      subject: message.subject,
    });
  } catch {
    // Intentionally ignored — the reply is already safely stored.
  }

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
      // Inbound HTML is never rendered anywhere in the app, and it is the only
      // channel through which an inline image or an embedded document could land
      // in the CRM. Store nothing — the plain-text body is what the inbox shows,
      // and any real attachment stays in Gmail where it can be opened.
      body_html: null,
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
 * Warmup replies are counted, not stored as conversations.
 *
 * Takes only the envelope fields, so it can be called from the prefilter
 * without downloading the message — peer warmup mail is by far the most common
 * thing in these inboxes and none of it has a body worth reading.
 */
async function recordWarmupReply(
  supabase: SupabaseClient,
  workspaceId: string,
  message: Pick<
    InboundMessage,
    "fromEmail" | "subject" | "inReplyTo" | "references"
  >,
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
