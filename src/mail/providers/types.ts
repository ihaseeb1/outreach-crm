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

export interface MailboxProvider {
  readonly kind: string;
  /** Checks the credentials work for both sending and receiving. */
  verify(): Promise<VerifyResult>;
  send(message: OutboundMessage): Promise<SendResult>;
  fetchInbound(options?: FetchInboundOptions): Promise<InboundMessage[]>;
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
  /** Messages in `folder` that carry the given header. */
  findByHeader(folder: string, header: string): Promise<FolderMessageRef[]>;
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
