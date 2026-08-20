import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { env } from "@/lib/env";
import { canSend, type BlockCode, type SendKind } from "@/mail/guard";
import { loadMailboxProvider } from "@/mail/providers";
import { CAMPAIGN_HEADER } from "@/mail/inbound-classify";
import { buildSignature, parseSocialKeys } from "@/mail/signature";
import { textToHtml } from "@/mail/template";
import {
  buildFooterHtml,
  buildFooterText,
  signatureCarriesAddress,
  unsubscribeHeaders,
} from "@/mail/unsubscribe";
import type { Message } from "@/types/db";

/**
 * The one outbound path.
 *
 * Order matters and is deliberate:
 *   1. canSend() — suppression, syntax, disposable, postal address
 *   2. reserve a slot against the mailbox's daily limit (atomic, in Postgres)
 *   3. build the message, appending the CAN-SPAM footer and unsubscribe headers
 *   4. hand it to the provider
 *   5. record it, releasing the reserved slot if the send failed
 *
 * Campaign sends, one-off sends, and warmup sends all come through here, so a
 * suppressed address cannot be emailed by any of them.
 */

export interface SendEmailInput {
  workspaceId: string;
  mailboxId: string;
  toEmail: string;
  toName?: string | null;
  subject: string;
  /** Plain text; HTML is generated from it unless `html` is supplied. */
  body: string;
  html?: string;
  kind?: SendKind;
  contactId?: string | null;
  campaignId?: string | null;
  stepNumber?: number | null;
  inReplyTo?: string | null;
  references?: string[];
  threadId?: string | null;
  extraHeaders?: Record<string, string>;
  /** Warmup mail is internal and carries no unsubscribe footer. */
  includeFooter?: boolean;
  postalAddress?: string | null;
  suppressed?: Set<string>;
  actorId?: string | null;
}

export type SendOutcome =
  | { ok: true; messageId: string; rowId: string; threadId: string }
  | { ok: false; code: BlockCode | "no_mailbox" | "send_failed"; reason: string };

export async function sendEmail(
  supabase: SupabaseClient,
  input: SendEmailInput,
): Promise<SendOutcome> {
  const kind = input.kind ?? "campaign";
  const includeFooter = input.includeFooter ?? kind !== "warmup";

  // 1. Compliance gate. Nothing below runs if this fails.
  const decision = await canSend(supabase, input.workspaceId, input.toEmail, {
    kind,
    postalAddress: input.postalAddress,
    suppressed: input.suppressed,
  });
  if (!decision.allowed) {
    return { ok: false, code: decision.code, reason: decision.reason };
  }
  const toEmail = decision.email;

  // 2. Daily limit. Reserved before sending so two concurrent jobs can never
  //    push a mailbox past its cap.
  const { data: reserved, error: reserveError } = await supabase.rpc(
    "mailbox_reserve_send",
    { mailbox: input.mailboxId },
  );
  if (reserveError) {
    return { ok: false, code: "send_failed", reason: reserveError.message };
  }
  if (reserved !== true) {
    return {
      ok: false,
      code: "daily_limit_reached",
      reason: "Mailbox is inactive, paused, or has hit its daily limit.",
    };
  }

  const release = async () => {
    await supabase.rpc("mailbox_release_send", { mailbox: input.mailboxId });
  };

  // 3. Provider.
  const loaded = await loadMailboxProvider(supabase, input.mailboxId);
  if (!loaded) {
    await release();
    return {
      ok: false,
      code: "no_mailbox",
      reason: "Mailbox not found or has no stored credentials.",
    };
  }
  const { mailbox, provider } = loaded;

  // 4. Body assembly.
  let text = input.body;
  let html = input.html ?? textToHtml(input.body);

  // Signature, and the social icon row under it. This is the one place outbound
  // mail carries images; mail/signature.ts explains why they have to be hosted
  // PNGs rather than the inline SVG the website uses.
  //
  // Warmup gets the signature but not the icons. Peer traffic between your own
  // mailboxes fetching four remote images every time is both pointless and a
  // distinctive fingerprint — the opposite of what warmup is for.
  const signature = buildSignature({
    signature: mailbox.signature,
    socials: kind === "warmup" ? [] : parseSocialKeys(mailbox.meta),
    baseUrl: env.appUrl(),
  });
  text += signature.text;
  html += signature.html;

  const headers: Record<string, string> = { ...input.extraHeaders };

  if (includeFooter) {
    const postal =
      input.postalAddress ??
      (await fetchPostalAddress(supabase, input.workspaceId));
    if (!postal) {
      await release();
      return {
        ok: false,
        code: "missing_postal_address",
        reason:
          "Set a sending postal address in Settings before sending (CAN-SPAM).",
      };
    }
    // The address is still required — the check above refuses to send without
    // one — but it is only printed here if the signature has not printed it
    // already. Otherwise the sign-off appears twice, once as itself and once as
    // the footer, which is what a full sign-off pasted into Settings produces.
    const footerInput = {
      workspaceId: input.workspaceId,
      recipientEmail: toEmail,
      postalAddress: signatureCarriesAddress(mailbox.signature, postal)
        ? null
        : postal,
    };
    text += buildFooterText(footerInput);
    html += buildFooterHtml(footerInput);
    Object.assign(headers, unsubscribeHeaders(input.workspaceId, toEmail));
  }

  if (input.campaignId) headers[CAMPAIGN_HEADER] = input.campaignId;

  // 5. Send.
  try {
    const result = await provider.send({
      to: toEmail,
      toName: input.toName,
      subject: input.subject,
      text,
      html,
      headers,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references,
    });

    const threadId = input.threadId ?? result.messageId;

    const { data: row } = await supabase
      .from("messages")
      .insert({
        workspace_id: input.workspaceId,
        campaign_id: input.campaignId ?? null,
        contact_id: input.contactId ?? null,
        mailbox_id: input.mailboxId,
        direction: "outbound",
        step_number: input.stepNumber ?? null,
        from_email: mailbox.email,
        to_email: toEmail,
        subject: input.subject,
        body: text,
        body_html: html,
        message_id: result.messageId,
        in_reply_to: input.inReplyTo ?? null,
        thread_id: threadId,
        status: "sent",
        sent_at: new Date().toISOString(),
        meta: { kind, response: result.response ?? null },
      })
      .select("id")
      .single();

    await supabase
      .from("mailboxes")
      .update({ last_error: null })
      .eq("id", input.mailboxId);

    await logActivity(supabase, {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      action: `mail.sent.${kind}`,
      entityType: "message",
      entityId: (row as { id: string } | null)?.id ?? null,
      meta: { to: toEmail, mailbox: mailbox.email, campaign_id: input.campaignId ?? null },
    });

    return {
      ok: true,
      messageId: result.messageId,
      rowId: (row as { id: string } | null)?.id ?? "",
      threadId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await release();

    await supabase.from("messages").insert({
      workspace_id: input.workspaceId,
      campaign_id: input.campaignId ?? null,
      contact_id: input.contactId ?? null,
      mailbox_id: input.mailboxId,
      direction: "outbound",
      step_number: input.stepNumber ?? null,
      from_email: mailbox.email,
      to_email: toEmail,
      subject: input.subject,
      body: text,
      status: "failed",
      error: reason,
      meta: { kind },
    } satisfies Partial<Message>);

    await supabase
      .from("mailboxes")
      .update({ last_error: reason })
      .eq("id", input.mailboxId);

    return { ok: false, code: "send_failed", reason };
  } finally {
    await provider.close().catch(() => undefined);
  }
}

async function fetchPostalAddress(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("workspaces")
    .select("sending_postal_address")
    .eq("id", workspaceId)
    .single();
  return (
    (data as { sending_postal_address: string | null } | null)
      ?.sending_postal_address ?? null
  );
}
