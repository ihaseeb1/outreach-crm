import { WARMUP_HEADER } from "@/mail/inbound-classify";

/**
 * MailboxProvider — the seam between the app and however a given mailbox
 * actually sends and receives.
 *
 * Phase 2 ships the SMTP/IMAP implementation (Gmail App Password). Phase 7 adds
 * Gmail and Microsoft OAuth2 providers behind this same interface, so nothing
 * in campaigns, warmup, or the inbox has to change.
 */

export interface OutboundMessage {
  to: string;
  toName?: string | null;
  subject: string;
  text: string;
  html: string;
  /** List-Unsubscribe and friends. */
  headers?: Record<string, string>;
  /** Set for follow-ups so they thread under the original email. */
  inReplyTo?: string | null;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response?: string;
}

export interface InboundMessage {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string | null;
  text: string;
  html: string | null;
  receivedAt: string;
  /** Set when the mail is a bounce/DSN or an auto-responder. */
  isBounce: boolean;
  isAutoReply: boolean;
  /** For a bounce, the address that actually failed. */
  bouncedRecipient: string | null;
  bounceType: "hard" | "soft" | null;
}

export interface FetchInboundOptions {
  /** Only fetch messages with a UID greater than this. */
  sinceUid?: number | null;
  limit?: number;
}

/**
 * Everything a poller needs to decide whether a message is worth downloading —
 * and nothing else.
 *
 * A full message can be megabytes; this is a few hundred bytes. Splitting the
 * poll into "look at the envelope" and then "read the ones that matter" is what
 * keeps a busy personal inbox inside the function's time budget: most of what
 * lands in one is newsletters and receipts that this app is never going to
 * store.
 */
export interface InboundHeader {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromName: string | null;
  toEmail: string | null;
  subject: string | null;
  receivedAt: string;
  /** Lower-cased header names, for the classifier. */
  headers: Record<string, string>;
}

/**
 * The headers fetched alongside the envelope.
 *
 * Kept short on purpose — every name here is another field the server has to
 * assemble. These are exactly the ones `classifyInbound` reads, plus
 * References, which the envelope does not carry.
 */
export const HEADER_FIELDS = [
  "references",
  "in-reply-to",
  "message-id",
  "content-type",
  "auto-submitted",
  "precedence",
  "x-autoreply",
  "x-autorespond",
  "x-auto-response-suppress",
  // Referenced, not spelled out: warmup mail is identified by this header, and
  // a copy of the string here that drifted from the one the sender writes would
  // quietly turn every warmup reply into an unexplained inbox entry.
  WARMUP_HEADER,
] as const;

/**
 * Parses a raw header block into a lower-cased map.
 *
 * Continuation lines (a header folded across several physical lines, which
 * References very often is) are joined onto the header they belong to — miss
 * that and a long References chain is truncated at the first fold, which is
 * precisely the case where threading matters most.
 */
export function parseHeaderBlock(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`.trim();
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    currentKey = line.slice(0, separator).trim().toLowerCase();
    headers[currentKey] = line.slice(separator + 1).trim();
  }

  return headers;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  /** Which legs verified — useful for telling the user what to fix. */
  smtp?: boolean;
  imap?: boolean;
}

/** Lightweight handle on a message in a folder, for warmup engagement. */
export interface FolderMessageRef {
  uid: number;
  messageId: string | null;
  subject: string | null;
}

/**
 * A folder message with the fields the warmup purge needs to make its safety
 * decision: who it is from and to (to re-check both are in the pool) and when it
 * arrived/was sent (to apply the retention cutoff). Deliberately richer than
 * FolderMessageRef so the purge never moves a message to Trash on the header
 * alone — it re-derives the pool-membership verdict from the envelope first.
 */
export interface PurgeMessageRef extends FolderMessageRef {
  fromEmail: string | null;
  toEmail: string | null;
  /** ISO date the message was sent/received (envelope date or internal date). */
  date: string | null;
}

export interface MailboxProvider {
  readonly kind: string;
  /** Checks the credentials work for both sending and receiving. */
  verify(): Promise<VerifyResult>;
  send(message: OutboundMessage): Promise<SendResult>;
  fetchInbound(options?: FetchInboundOptions): Promise<InboundMessage[]>;
  /**
   * A poll in two phases down **one** connection.
   *
   * Phase one lists envelopes — cheap enough to run over every unseen message.
   * `choose` then decides which of them are worth reading, and phase two
   * downloads only those. The decision needs database lookups, so it is async,
   * and the connection is deliberately held open across it: reconnecting
   * between the phases would double the number of IMAP sessions a poll opens,
   * on exactly the provider that is fussiest about how many are open at once.
   */
  fetchInboundSelective(
    options: FetchInboundOptions,
    choose: (headers: InboundHeader[]) => Promise<number[]>,
  ): Promise<{ headers: InboundHeader[]; messages: InboundMessage[] }>;
  /**
   * Messages the user has starred, newest first.
   *
   * Starring in Gmail is the one signal a person gives by hand that says "this
   * reply matters" — it is how the good publisher quotes get marked, and it
   * costs no extra scope, being the IMAP `\Flagged` flag.
   */
  fetchFlagged(options?: { limit?: number }): Promise<InboundMessage[]>;

  // --- Folder operations, used by warmup engagement -------------------
  /** The provider's spam folder (\Junk special-use), if it has one. */
  findSpamFolder(): Promise<string | null>;
  /** The provider's Trash folder (\Trash special-use), if it has one. Warmup
   * mail is MOVED here, never permanently deleted, so it stays recoverable
   * (Gmail keeps Trash for ~30 days) and can be reviewed. */
  findTrashFolder(): Promise<string | null>;
  /** The provider's Sent folder (\Sent special-use), if it has one — where the
   * sender's own copy of a warmup email lives. */
  findSentFolder(): Promise<string | null>;
  /** Messages in `folder` that carry the given header. */
  findByHeader(folder: string, header: string): Promise<FolderMessageRef[]>;
  /** Like findByHeader, but with sender/recipient/date for the purge's
   * pool-membership re-check and retention cutoff. */
  findByHeaderForPurge(folder: string, header: string): Promise<PurgeMessageRef[]>;
  addFlags(folder: string, uids: number[], flags: string[]): Promise<void>;
  /**
   * Flags one message by its RFC 5322 Message-ID, wherever it happens to live.
   *
   * Used to star a conversation in the real mailbox when a deal is logged here.
   * Which folder a message sits in is not knowable from our side — Gmail files
   * a reply under INBOX, but a user may have archived it — so the lookup walks
   * the likely folders rather than assuming one. Returns the folder it flagged,
   * or null if the message was not found.
   */
  flagByMessageId(messageId: string, flags: string[]): Promise<string | null>;
  /** Returns how many messages were moved. */
  moveMessages(folder: string, uids: number[], destination: string): Promise<number>;

  /** Providers open connections lazily; this releases whatever was opened. */
  close(): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * OAuth2 credentials. The refresh token is the long-lived secret; access tokens
 * are short-lived and refreshed on demand rather than stored for long.
 */
export interface OAuthCredentials {
  provider: "google" | "microsoft";
  refreshToken: string;
  accessToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface MailboxCredentials {
  smtp: SmtpConfig;
  imap: ImapConfig;
  /** When present, XOAUTH2 is used instead of the stored password. */
  oauth?: OAuthCredentials;
}
