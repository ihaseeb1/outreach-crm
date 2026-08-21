/**
 * Which inbound messages are worth downloading.
 *
 * A poll used to fetch the full source of every message above the checkpoint
 * and parse it before deciding what it was. On a personal Gmail account that
 * means downloading newsletters, receipts, calendar invites and notifications —
 * megabytes of mail this app will never store — and it is the reason two
 * mailboxes reported "Timed out after 25s" while the rest got through.
 *
 * So the poll asks for envelopes first and runs this. Only mail that is going
 * to be *stored* gets read in full:
 *
 *   - a message already stored is a duplicate, and nothing needs reading
 *   - warmup traffic is counted, never stored, and the envelope carries
 *     everything the counter needs
 *   - a bounce needs its body, because the failed address is inside it
 *   - a reply needs its body, but only if it ties back to outreach we sent
 *   - everything else is somebody's ordinary mail and is left alone
 *
 * Pure, so the decision that governs what the inbox shows is covered by tests
 * rather than assumed.
 */

import { classifyInbound } from "@/mail/inbound-classify";
import type { InboundHeader } from "@/mail/providers/types";

export type PrefilterVerdict =
  /** Stored by an earlier poll. */
  | "duplicate"
  /** Peer warmup mail: counted from the envelope, never stored. */
  | "warmup"
  /** Worth the full download — a bounce, or a reply to something we sent. */
  | "fetch"
  /** Not ours. Skipped without being read. */
  | "ignored";

export interface PrefilterContext {
  /** Every address connected to this workspace. */
  ownMailboxes: Set<string>;
  /** Message-IDs already in the messages table. */
  storedMessageIds: Set<string>;
  /** Addresses this workspace has sent outreach to. */
  outreachRecipients: Set<string>;
  /** Message-IDs of our own outbound mail, for threading. */
  outboundMessageIds: Set<string>;
}

export function decideInbound(
  header: InboundHeader,
  context: PrefilterContext,
): PrefilterVerdict {
  if (header.messageId && context.storedMessageIds.has(header.messageId)) {
    return "duplicate";
  }

  const classification = classifyInbound({
    fromEmail: header.fromEmail,
    subject: header.subject ?? "",
    // Deliberately empty: the body is exactly what has not been downloaded yet.
    // Every rule that needs it — pulling the failed address out of a DSN — runs
    // again on the full message once this says it is worth fetching.
    text: "",
    headers: header.headers,
    ownMailboxes: context.ownMailboxes,
  });

  if (classification.kind === "warmup") return "warmup";

  // A bounce is always read: which address failed is only in the body, and
  // getting that wrong means suppressing nobody or suppressing the wrong
  // person.
  if (classification.kind === "bounce") return "fetch";

  return isLinkedToOutreach(header, context) ? "fetch" : "ignored";
}

/**
 * Does this message answer something we sent?
 *
 * The same two tests `linkToOutreach` applies after the download — threading
 * headers first, then the sender's address — so the prefilter can never skip a
 * message the storing path would have kept.
 */
export function isLinkedToOutreach(
  header: InboundHeader,
  context: Pick<PrefilterContext, "outreachRecipients" | "outboundMessageIds">,
): boolean {
  const references = [header.inReplyTo, ...header.references].filter(
    (value): value is string => Boolean(value),
  );

  if (references.some((reference) => context.outboundMessageIds.has(reference))) {
    return true;
  }

  return context.outreachRecipients.has(header.fromEmail);
}

/** Every Message-ID a batch of headers points at, for one `in` query. */
export function referencedMessageIds(headers: InboundHeader[]): string[] {
  const ids = new Set<string>();
  for (const header of headers) {
    if (header.inReplyTo) ids.add(header.inReplyTo);
    for (const reference of header.references) ids.add(reference);
  }
  return [...ids];
}

export function senderAddresses(headers: InboundHeader[]): string[] {
  return [
    ...new Set(headers.map((header) => header.fromEmail).filter(Boolean)),
  ];
}
