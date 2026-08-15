import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import { classifyInbound } from "@/mail/inbound-classify";
import type {
  FetchInboundOptions,
  InboundMessage,
  MailboxCredentials,
  MailboxProvider,
  OutboundMessage,
  SendResult,
  VerifyResult,
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

  constructor(
    private readonly credentials: MailboxCredentials,
    private readonly fromEmail: string,
    private readonly fromName: string | null,
  ) {}

  private smtp(): Transporter {
    if (this.transporter) return this.transporter;
    const { host, port, secure, user, pass } = this.credentials.smtp;
    const options: SMTPTransport.Options = {
      host,
      port,
      secure,
      auth: { user, pass },
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
      await this.smtp().verify();
      result.smtp = true;
    } catch (error) {
      result.error = `SMTP: ${message(error)}`;
      return result;
    }

    const client = this.imapClient();
    try {
      await client.connect();
      await client.getMailboxLock("INBOX").then((lock) => lock.release());
      result.imap = true;
    } catch (error) {
      result.error = `IMAP: ${message(error)}`;
      return result;
    } finally {
      await client.logout().catch(() => undefined);
    }

    result.ok = true;
    return result;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const info = await this.smtp().sendMail({
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

  private imapClient(): ImapFlow {
    const { host, port, secure, user, pass } = this.credentials.imap;
    return new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
      emitLogs: false,
    });
  }

  async fetchInbound(
    options: FetchInboundOptions = {},
  ): Promise<InboundMessage[]> {
    const limit = options.limit ?? 25;
    const client = this.imapClient();
    const results: InboundMessage[] = [];

    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // UID-based so we resume exactly where the last poll stopped, with no
      // dependency on the \Seen flag (which the user may toggle themselves).
      const since = options.sinceUid ?? 0;
      const range = `${since + 1}:*`;

      for await (const item of client.fetch(
        range,
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
      await client.logout().catch(() => undefined);
    }

    return results;
  }

  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }
}

function toInboundMessage(uid: number, parsed: ParsedMail): InboundMessage {
  const from = parsed.from?.value?.[0];
  const to = Array.isArray(parsed.to) ? parsed.to[0]?.value?.[0] : parsed.to?.value?.[0];

  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }

  const text = parsed.text ?? "";
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

function normalizeReferences(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
