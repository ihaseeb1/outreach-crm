import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import { classifyInbound } from "@/mail/inbound-classify";
import { accessTokenFor } from "@/mail/providers/oauth";
import {
  HEADER_FIELDS,
  parseHeaderBlock,
  type FetchInboundOptions,
  type FolderMessageRef,
  type InboundHeader,
  type InboundMessage,
  type MailboxCredentials,
  type MailboxProvider,
  type OutboundMessage,
  type SendResult,
  type VerifyResult,
} from "@/mail/providers/types";

/**
 * SMTP send + IMAP receive using a username and app password.
 *
 * Connections are opened per operation and closed immediately — serverless
 * functions cannot hold a persistent IMAP connection, and Gmail drops idle
 * ones anyway.
 */
export class SmtpProvider implements MailboxProvider {
  readonly kind = "smtp";

  private transporter: Transporter | null = null;

  /**
   * Every IMAP client currently mid-operation.
   *
   * Without this, `close()` could only ever tear down SMTP, so a poll that was
   * abandoned on a timeout left its IMAP socket open and reading. Those orphans
   * are what produced the pair of errors the user kept seeing: the socket
   * eventually died on its own and every later command on it answered
   * "Connection not available", while Gmail counted the abandoned connections
   * against its per-account simultaneous-connection limit and refused the next
   * one. A caller that gives up now actually hangs up.
   */
  private readonly liveClients = new Set<ImapFlow>();

  /** Set by `close()`. A closed provider refuses to open anything new. */
  private closed = false;

  constructor(
    private readonly credentials: MailboxCredentials,
    private readonly fromEmail: string,
    private readonly fromName: string | null,
  ) {}

  /**
   * Password or XOAUTH2, decided by whether OAuth credentials are stored.
   * Everything downstream — send, fetch, folder ops — is identical either way.
   */
  private async smtpAuth(): Promise<SMTPTransport.Options["auth"]> {
    const { user, pass } = this.credentials.smtp;
    if (this.credentials.oauth) {
      return {
        type: "OAuth2",
        user,
        accessToken: await accessTokenFor(this.credentials.oauth),
      };
    }
    return { user, pass };
  }

  private async imapAuth(): Promise<{ user: string; pass?: string; accessToken?: string }> {
    const { user, pass } = this.credentials.imap;
    if (this.credentials.oauth) {
      return { user, accessToken: await accessTokenFor(this.credentials.oauth) };
    }
    return { user, pass };
  }

  private async smtp(): Promise<Transporter> {
    if (this.transporter) return this.transporter;
    const { host, port, secure } = this.credentials.smtp;
    const options: SMTPTransport.Options = {
      host,
      port,
      secure,
      auth: await this.smtpAuth(),
      // Unpooled (nodemailer's default): one connection per message keeps sends
      // spaced out, so Gmail never sees a burst down a single connection.
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 30_000,
    };
    this.transporter = nodemailer.createTransport(options);
    return this.transporter;
  }

  async verify(): Promise<VerifyResult> {
    const result: VerifyResult = { ok: false, smtp: false, imap: false };

    try {
      await (await this.smtp()).verify();
      result.smtp = true;
    } catch (error) {
      result.error = `SMTP: ${message(error)}`;
      return result;
    }

    try {
      // No retry: verify exists to report the real reason a mailbox will not
      // connect, and a retry would only ever hide the first error behind the
      // second.
      await this.withImap(
        async (client) => {
          const lock = await client.getMailboxLock("INBOX");
          lock.release();
        },
        { retries: 0 },
      );
      result.imap = true;
    } catch (error) {
      result.error = `IMAP: ${message(error)}`;
      return result;
    }

    result.ok = true;
    return result;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const transporter = await this.smtp();
    const info = await transporter.sendMail({
      from: this.fromName
        ? { name: this.fromName, address: this.fromEmail }
        : this.fromEmail,
      to: msg.toName ? { name: msg.toName, address: msg.to } : msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.headers,
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
      ...(msg.references?.length ? { references: msg.references } : {}),
    });

    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: info.response,
    };
  }

  private async imapClient(): Promise<ImapFlow> {
    const { host, port, secure } = this.credentials.imap;
    return new ImapFlow({
      host,
      port,
      secure,
      auth: await this.imapAuth(),
      logger: false,
      emitLogs: false,
      // Without these a stalled connection waits on the OS socket timeout —
      // minutes — which is far longer than the function is allowed to live, so
      // the whole run dies with it and reports nothing.
      //
      // socketTimeout is deliberately *below* the caller's per-mailbox ceiling
      // (25s in the poller). It used to be 30s, above it, which meant a stalled
      // socket could never surface as a named IMAP error — the poller's
      // stopwatch always fired first and the only thing anyone ever saw was
      // "Timed out after 25s", with no clue whether it was the connect, the
      // login or the fetch.
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 18_000,
    });
  }

  /**
   * Connect, run one piece of work, hang up — with a retry.
   *
   * Gmail's IMAP frontend refuses or drops connections often enough that a
   * single attempt is not a fair test of a mailbox: "Connection not available"
   * and "socket timeout" are both usually gone by the second try a second
   * later. Only transient failures are retried — a wrong app password would
   * otherwise be asked twice and reported just as slowly.
   */
  private async withImap<T>(
    fn: (client: ImapFlow) => Promise<T>,
    options: { retries?: number } = {},
  ): Promise<T> {
    const retries = options.retries ?? 1;
    let lastError: unknown = new Error("IMAP: no attempt was made.");

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (this.closed) throw new Error("The mailbox connection was closed.");

      const client = await this.imapClient();
      this.liveClients.add(client);

      try {
        await client.connect();
        return await fn(client);
      } catch (error) {
        lastError = error;
        if (this.closed || attempt >= retries || !isTransient(error)) break;
        await pause(600 * (attempt + 1));
      } finally {
        this.liveClients.delete(client);
        // logout() is the polite close and can itself hang on a dead socket;
        // close() is the guaranteed one. Both, in that order.
        await client.logout().catch(() => undefined);
        try {
          client.close();
        } catch {
          // Already gone.
        }
      }
    }

    throw lastError;
  }

  /**
   * Envelopes and a handful of headers for everything above the checkpoint.
   *
   * This is the cheap half of the two-phase poll. One IMAP command, no message
   * bodies: a personal Gmail account collects newsletters, receipts and
   * notifications, and downloading all of that in full — which is what a
   * single-phase poll did — is what pushed a poll past 25 seconds. Deciding
   * what is worth reading costs a few kilobytes; reading it costs megabytes.
   */
  async fetchInboundSelective(
    options: FetchInboundOptions,
    choose: (headers: InboundHeader[]) => Promise<number[]>,
  ): Promise<{ headers: InboundHeader[]; messages: InboundMessage[] }> {
    const limit = options.limit ?? 200;
    const since = options.sinceUid ?? 0;

    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock("INBOX");

      try {
        const headers = await readHeaders(client, since, limit);
        // The caller's decision runs while the connection is held. It is a
        // handful of indexed queries, and holding a socket open for that is far
        // cheaper than logging in a second time.
        const wanted = await choose(headers);
        const messages = await readMessages(client, wanted);
        return { headers, messages };
      } finally {
        lock.release();
      }
    });
  }

  async fetchInbound(
    options: FetchInboundOptions = {},
  ): Promise<InboundMessage[]> {
    const limit = options.limit ?? 25;
    const since = options.sinceUid ?? 0;

    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      const results: InboundMessage[] = [];

      try {
        // UID-based so we resume exactly where the last poll stopped, with no
        // dependency on the \Seen flag (which the user may toggle themselves).
        for await (const item of client.fetch(
          `${since + 1}:*`,
          { uid: true, source: true, envelope: true, internalDate: true },
          { uid: true },
        )) {
          if (item.uid <= since) continue;
          if (!item.source) continue;

          const parsed = await simpleParser(item.source);
          results.push(toInboundMessage(item.uid, parsed));

          if (results.length >= limit) break;
        }
      } finally {
        lock.release();
      }

      return results;
    });
  }

  /**
   * The starred mail in the inbox, newest first.
   *
   * INBOX only, deliberately: a star elsewhere is usually the user's own
   * bookkeeping, and searching All Mail on a busy account is slow enough to
   * cost the whole request.
   */
  async fetchFlagged(options: { limit?: number } = {}): Promise<InboundMessage[]> {
    const limit = options.limit ?? 10;

    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      const results: InboundMessage[] = [];

      try {
        const uids = await client.search({ flagged: true }, { uid: true });
        if (!uids || uids.length === 0) return [];

        // Highest UIDs are the most recent, and they are what a person has just
        // starred while looking for help with a quote.
        const newest = uids.slice(-limit);

        for await (const item of client.fetch(
          newest,
          { uid: true, source: true, envelope: true, internalDate: true },
          { uid: true },
        )) {
          if (!item.source) continue;
          results.push(toInboundMessage(item.uid, await simpleParser(item.source)));
        }
      } finally {
        lock.release();
      }

      return results.reverse();
    });
  }

  /**
   * Runs `fn` against a connected, locked mailbox and always tears the
   * connection down afterwards.
   */
  private async withFolder<T>(
    folder: string,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  async findSpamFolder(): Promise<string | null> {
    try {
      return await this.withImap(async (client) => {
        const folders = await client.list();
        const bySpecialUse = folders.find(
          (folder) => folder.specialUse === "\\Junk",
        );
        if (bySpecialUse) return bySpecialUse.path;

        // Not every server advertises SPECIAL-USE; fall back to the usual names.
        const byName = folders.find((folder) =>
          /^(junk|spam|bulk mail|junk e-?mail)$/i.test(folder.name),
        );
        return byName?.path ?? null;
      });
    } catch {
      return null;
    }
  }

  async findByHeader(
    folder: string,
    header: string,
  ): Promise<FolderMessageRef[]> {
    try {
      return await this.withFolder(folder, async (client) => {
        // An empty value matches any message carrying the header at all.
        const uids = await client.search({ header: { [header]: "" } }, { uid: true });
        if (!uids || uids.length === 0) return [];

        const refs: FolderMessageRef[] = [];
        for await (const item of client.fetch(
          uids.slice(-100),
          { uid: true, envelope: true },
          { uid: true },
        )) {
          refs.push({
            uid: item.uid,
            messageId: item.envelope?.messageId ?? null,
            subject: item.envelope?.subject ?? null,
          });
        }
        return refs;
      });
    } catch {
      // A missing folder is normal (not every account has a Junk folder).
      return [];
    }
  }

  /**
   * Finds one message by Message-ID and flags it.
   *
   * Gmail's "All Mail" is searched as well as the inbox: starring has to work on
   * a thread the user has already archived, and on Gmail a message is only ever
   * in one place as far as IMAP is concerned. The \All special-use folder is
   * resolved from the server rather than hardcoded as "[Gmail]/All Mail",
   * because that name is localised.
   */
  async flagByMessageId(messageId: string, flags: string[]): Promise<string | null> {
    if (!messageId) return null;

    return this.withImap(async (client) => {
      const folders = await client.list().catch(() => []);
      const allMail = folders.find((folder) => folder.specialUse === "\\All");

      const candidates = ["INBOX", allMail?.path].filter(
        (path): path is string => Boolean(path),
      );

      for (const folder of candidates) {
        const lock = await client.getMailboxLock(folder).catch(() => null);
        if (!lock) continue;

        try {
          // imapflow normalises the angle brackets, so both forms match.
          const uids = await client.search(
            { header: { "message-id": messageId } },
            { uid: true },
          );
          if (uids && uids.length > 0) {
            await client.messageFlagsAdd(uids, flags, { uid: true });
            return folder;
          }
        } catch {
          // A folder that cannot be searched is skipped, not fatal.
        } finally {
          lock.release();
        }
      }

      return null;
    });
  }

  async addFlags(folder: string, uids: number[], flags: string[]): Promise<void> {
    if (uids.length === 0) return;
    await this.withFolder(folder, async (client) => {
      await client.messageFlagsAdd(uids, flags, { uid: true });
    });
  }

  async moveMessages(
    folder: string,
    uids: number[],
    destination: string,
  ): Promise<number> {
    if (uids.length === 0) return 0;
    try {
      return await this.withFolder(folder, async (client) => {
        await client.messageMove(uids, destination, { uid: true });
        return uids.length;
      });
    } catch {
      return 0;
    }
  }

  /**
   * Hangs up on everything, including work still in flight.
   *
   * Called both on the normal path and by a caller that has given up waiting.
   * The second case is the important one: an abandoned IMAP socket goes on
   * counting against Gmail's per-account connection limit until the server
   * eventually reaps it, and that is what turns one slow mailbox into
   * "Connection not available" on the next three.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.transporter?.close();
    this.transporter = null;

    for (const client of this.liveClients) {
      try {
        client.close();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.liveClients.clear();
  }
}

/**
 * Errors worth trying again. Everything here is a network or connection-slot
 * problem rather than a statement about the mailbox: an app password does not
 * become correct on the second attempt, but a refused connection frequently
 * does.
 */
function isTransient(error: unknown): boolean {
  const text = message(error).toLowerCase();
  return (
    /connection not available/.test(text) ||
    /socket timeout|socket closed|socket hang ?up/.test(text) ||
    /timed? ?out/.test(text) ||
    /econnreset|econnrefused|epipe|etimedout|enotfound|eai_again|enetunreach/.test(
      text,
    ) ||
    /too many (?:simultaneous )?connections|temporarily unavailable|try again/.test(
      text,
    )
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * imapflow types an envelope date as `string | Date` — it is a Date in
 * practice, but a server that sends an unparseable Date header leaves the raw
 * string. An unreadable date must not lose the message, so it falls back to
 * now.
 */
function asIsoDate(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed)
    ? new Date().toISOString()
    : new Date(parsed).toISOString();
}

/**
 * Envelopes and a short list of headers for everything above the checkpoint.
 *
 * The cheap half of a poll. One IMAP command, no message bodies: a personal
 * Gmail account collects newsletters, receipts and notifications, and
 * downloading all of that in full — which is what a single-phase poll did — is
 * what pushed a poll past 25 seconds. Deciding what is worth reading costs a
 * few kilobytes; reading it costs megabytes.
 */
async function readHeaders(
  client: ImapFlow,
  since: number,
  limit: number,
): Promise<InboundHeader[]> {
  const results: InboundHeader[] = [];

  for await (const item of client.fetch(
    `${since + 1}:*`,
    { uid: true, envelope: true, internalDate: true, headers: [...HEADER_FIELDS] },
    { uid: true },
  )) {
    if (item.uid <= since) continue;

    const headers = parseHeaderBlock(
      item.headers ? item.headers.toString("utf8") : "",
    );
    const envelope = item.envelope;
    const from = envelope?.from?.[0];
    const to = envelope?.to?.[0];

    results.push({
      uid: item.uid,
      messageId: envelope?.messageId ?? headers["message-id"] ?? null,
      inReplyTo: envelope?.inReplyTo ?? headers["in-reply-to"] ?? null,
      references: (headers["references"] ?? "")
        .split(/\s+/)
        .filter((value) => value.startsWith("<")),
      fromEmail: (from?.address ?? "").toLowerCase(),
      fromName: from?.name || null,
      toEmail: to?.address?.toLowerCase() ?? null,
      subject: envelope?.subject ?? null,
      receivedAt: asIsoDate(envelope?.date ?? item.internalDate),
      headers,
    });

    if (results.length >= limit) break;
  }

  return results;
}

/** The expensive half: full sources, for the UIDs the caller asked for. */
async function readMessages(
  client: ImapFlow,
  uids: number[],
): Promise<InboundMessage[]> {
  if (uids.length === 0) return [];

  const results: InboundMessage[] = [];
  for await (const item of client.fetch(
    uids,
    { uid: true, source: true, envelope: true, internalDate: true },
    { uid: true },
  )) {
    if (!item.source) continue;
    results.push(toInboundMessage(item.uid, await simpleParser(item.source)));
  }

  return results;
}

function toInboundMessage(uid: number, parsed: ParsedMail): InboundMessage {
  const from = parsed.from?.value?.[0];
  const to = Array.isArray(parsed.to) ? parsed.to[0]?.value?.[0] : parsed.to?.value?.[0];

  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }

  // Plain text only. If a reply is HTML-only, fall back to a tag-stripped
  // version rather than an empty body — but never carry the HTML itself, so
  // inline images and embedded documents never enter the CRM (attachments in
  // `parsed.attachments` are likewise ignored; they stay in Gmail).
  const text = parsed.text?.trim()
    ? parsed.text
    : typeof parsed.html === "string"
      ? htmlToText(parsed.html)
      : "";
  const classification = classifyInbound({
    fromEmail: from?.address ?? "",
    subject: parsed.subject ?? "",
    text,
    headers,
  });

  return {
    uid,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: normalizeReferences(parsed.references),
    fromEmail: (from?.address ?? "").toLowerCase(),
    fromName: from?.name || null,
    toEmail: to?.address?.toLowerCase() ?? null,
    subject: parsed.subject ?? null,
    text,
    html: typeof parsed.html === "string" ? parsed.html : null,
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    isBounce: classification.kind === "bounce",
    isAutoReply: classification.kind === "auto_reply",
    bouncedRecipient: classification.bouncedRecipient,
    bounceType: classification.bounceType,
  };
}

/** Crude HTML → text for the rare HTML-only reply. Drops scripts/styles and
 * tags, decodes the handful of entities that matter, collapses blank runs. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeReferences(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
