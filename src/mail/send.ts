import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { env } from "@/lib/env";
import { canSend, type BlockCode, type SendKind } from "@/mail/guard";
import { loadMailboxProvider } from "@/mail/providers";
import { CAMPAIGN_HEADER } from "@/mail/inbound-classify";
import {
  buildSignature,
  parseSocialKeys,
  signatureCarriesAddress,
} from "@/mail/signature";
import { textToHtml } from "@/mail/template";
import { trackBody, trackPixel } from "@/mail/tracking";
import {
  resolveTrackingMode,
  type TrackingMode,
} from "@/mail/tracking-summary";
import {
  buildFooterHtml,
  buildFooterText,
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
  /**
   * Whether to append the closing block — postal address, social icons, opt-out.
   *
   * Defaults to **true for every kind, warmup included**. Warmup used to be
   * excluded, on the reasoning that peer mail between your own mailboxes
   * fetching four remote images was pointless and a distinctive fingerprint.
   * That was the wrong way round: leaving the block off did not make warmup look
   * like nothing, it made it look like a *different sender* from the one being
   * warmed up. The account being trained then had two shapes of outbound mail,
   * and only one of them was the shape real outreach goes out in.
   */
  includeFooter?: boolean;
  postalAddress?: string | null;
  suppressed?: Set<string>;
  actorId?: string | null;
  /**
   * Open/click tracking for this one email.
   *
   * Omitted means "ask the workspace", which costs a query — campaign batches
   * pass it in so that query happens once per run rather than once per send.
   * Warmup passes "off" explicitly: it goes between your own mailboxes, so a
   * pixel there measures nothing and adds a remote image to traffic that is
   * meant to look like ordinary correspondence.
   */
  tracking?: TrackingMode;
}

export type SendOutcome =
  | { ok: true; messageId: string; rowId: string; threadId: string }
  | { ok: false; code: BlockCode | "no_mailbox" | "send_failed"; reason: string };

export async function sendEmail(
  supabase: SupabaseClient,
  input: SendEmailInput,
): Promise<SendOutcome> {
  const kind = input.kind ?? "campaign";
  const includeFooter = input.includeFooter ?? true;

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
  // Warmup is allowed to run from a health-auto-paused mailbox — that is how a
  // paused box recovers — but campaign and one-off sends are not.
  const { data: reserved, error: reserveError } = await reserveSend(
    supabase,
    input.mailboxId,
    kind === "warmup",
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
  //
  // The row id is minted here rather than left to Postgres, because the
  // tracking pixel and every rewritten link have to carry it — and they are
  // written into the email that is sent before the row exists. Inserting with
  // an explicit id is what lets the URL in the recipient's inbox and the row
  // this app later reads be the same message.
  const rowId = crypto.randomUUID();

  let text = input.body;
  let html = input.html ?? textToHtml(input.body);

  const headers: Record<string, string> = { ...input.extraHeaders };

  // The postal address is resolved before the sign-off, because whether the
  // sign-off is printed at all depends on it.
  let postal: string | null = null;
  let tracking = input.tracking;

  if (includeFooter) {
    if (input.postalAddress !== undefined && input.postalAddress !== null) {
      postal = input.postalAddress;
    } else {
      // One read for both, since both live on the workspace row.
      const config = await fetchSendingConfig(supabase, input.workspaceId);
      postal = config.postalAddress;
      tracking ??= config.tracking;
    }
    if (!postal) {
      await release();
      return {
        ok: false,
        code: "missing_postal_address",
        reason:
          "Set a sending postal address in Settings before sending (CAN-SPAM).",
      };
    }
  }

  // A personal sign-off above the closing block — skipped when it only repeats
  // the address that block already prints, which is what put the same text on
  // the email twice.
  if (tracking === undefined) {
    tracking = (await fetchSendingConfig(supabase, input.workspaceId)).tracking;
  }

  // Links are rewritten in the body only, and before anything is appended to
  // it. The signature and the closing block must come through untouched: the
  // unsubscribe link has to be exactly what the List-Unsubscribe header
  // promises, and routing our own footer through a click counter would score
  // the footer as engagement.
  html = trackBody(html, { messageId: rowId, mode: tracking });

  const signature = buildSignature({
    signature: signatureCarriesAddress(mailbox.signature, postal)
      ? null
      : mailbox.signature,
  });
  text += signature.text;
  html += signature.html;

  if (postal) {
    // The closing block: address, the company's links, opt-out. This is the one
    // place outbound mail carries images; mail/signature.ts explains why they
    // have to be hosted PNGs rather than the inline SVG the website uses.
    //
    // Warmup comes through here too. Every email this workspace sends ends the
    // same way, so the mailbox being warmed is being trained on the exact shape
    // of message it will later send for real.
    const footerInput = {
      workspaceId: input.workspaceId,
      recipientEmail: toEmail,
      postalAddress: postal,
      socials: parseSocialKeys(mailbox.meta),
      baseUrl: env.appUrl(),
    };
    text += buildFooterText(footerInput);
    html += buildFooterHtml(footerInput);
    Object.assign(headers, unsubscribeHeaders(input.workspaceId, toEmail));
  }

  if (input.campaignId) headers[CAMPAIGN_HEADER] = input.campaignId;

  // Last thing in the HTML, after the closing block, where a 1×1 image cannot
  // push anything around.
  html = trackPixel(html, { messageId: rowId, mode: tracking });

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
        id: rowId,
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
        // The mode is recorded on the message, not just read from the workspace
        // at display time: turning tracking off later must not make every email
        // ever sent read as "never opened" rather than "not tracked".
        meta: {
          kind,
          response: result.response ?? null,
          tracking: { mode: tracking },
        },
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
      rowId: (row as { id: string } | null)?.id ?? rowId,
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

const MISSING_FN = /function|schema cache|PGRST202|does not exist/i;

/**
 * Reserves a daily-limit slot. Campaigns and one-off sends call the strict
 * one-argument form (blocks a paused mailbox), which exists in every schema
 * version.
 *
 * Warmup reserves through `mailbox_reserve_warmup` (migration 0014): it counts
 * against the same shared daily cap but pings `last_warmup_at`, not
 * `last_send_at`, so warming a mailbox aggressively never resets the outreach
 * rest clock. If that function is not there yet it falls back to the
 * `allow_paused` reserve, and then to the strict form — so a deploy can always
 * land before its SQL migration without breaking sending.
 */
async function reserveSend(
  supabase: SupabaseClient,
  mailboxId: string,
  isWarmup: boolean,
): Promise<{ data: unknown; error: { message: string } | null }> {
  if (!isWarmup) {
    return supabase.rpc("mailbox_reserve_send", { mailbox: mailboxId });
  }

  const warmup = await supabase.rpc("mailbox_reserve_warmup", { mailbox: mailboxId });
  if (!warmup.error || !MISSING_FN.test(warmup.error.message)) {
    return warmup;
  }

  // 0014 not applied yet: fall back to the paused-aware reserve (0007), then to
  // the strict one. These bump last_send_at, but only until the migration lands.
  const paused = await supabase.rpc("mailbox_reserve_send", {
    mailbox: mailboxId,
    allow_paused: true,
  });
  if (paused.error && MISSING_FN.test(paused.error.message)) {
    return supabase.rpc("mailbox_reserve_send", { mailbox: mailboxId });
  }
  return paused;
}

/**
 * The two workspace-level facts a send needs: the postal address, and whether
 * to track. One row, one query — they were two reads of the same row before.
 */
export async function fetchSendingConfig(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ postalAddress: string | null; tracking: TrackingMode }> {
  const { data } = await supabase
    .from("workspaces")
    .select("sending_postal_address, settings")
    .eq("id", workspaceId)
    .single();

  const row = data as {
    sending_postal_address: string | null;
    settings: Record<string, unknown> | null;
  } | null;

  return {
    postalAddress: row?.sending_postal_address ?? null,
    tracking: resolveTrackingMode(row?.settings),
  };
}
