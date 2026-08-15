import crypto from "node:crypto";

import { env } from "@/lib/env";
import { normalizeEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/html";

/**
 * Stateless one-click unsubscribe links.
 *
 * The token is an HMAC over workspace + address, so no table lookup is needed
 * and a link cannot be forged or edited to unsubscribe someone else.
 */

function signature(workspaceId: string, email: string): string {
  return crypto
    .createHmac("sha256", env.encryptionKey())
    .update(`${workspaceId}:${normalizeEmail(email)}`)
    .digest("base64url");
}

export function unsubscribeUrl(workspaceId: string, email: string): string {
  const params = new URLSearchParams({
    w: workspaceId,
    e: Buffer.from(normalizeEmail(email), "utf8").toString("base64url"),
    s: signature(workspaceId, email),
  });
  return `${env.appUrl()}/api/unsubscribe?${params.toString()}`;
}

export interface UnsubscribeToken {
  workspaceId: string;
  email: string;
}

export function verifyUnsubscribeParams(
  params: URLSearchParams,
): UnsubscribeToken | null {
  const workspaceId = params.get("w");
  const encodedEmail = params.get("e");
  const provided = params.get("s");
  if (!workspaceId || !encodedEmail || !provided) return null;

  let email: string;
  try {
    email = normalizeEmail(Buffer.from(encodedEmail, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!email.includes("@")) return null;

  const expected = signature(workspaceId, email);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { workspaceId, email };
}

/**
 * List-Unsubscribe headers. `List-Unsubscribe-Post` opts into RFC 8058
 * one-click, which Gmail and Outlook surface as a native unsubscribe button —
 * a meaningful deliverability signal on top of being legally required.
 */
export function unsubscribeHeaders(
  workspaceId: string,
  email: string,
): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl(workspaceId, email)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export interface FooterInput {
  workspaceId: string;
  recipientEmail: string;
  postalAddress: string;
  senderName?: string | null;
}

/** CAN-SPAM footer: physical address + a working opt-out, on every campaign email. */
export function buildFooterText(input: FooterInput): string {
  return [
    "",
    "—",
    input.postalAddress.trim(),
    "",
    `Don't want to hear from me again? Unsubscribe: ${unsubscribeUrl(
      input.workspaceId,
      input.recipientEmail,
    )}`,
  ].join("\n");
}

export function buildFooterHtml(input: FooterInput): string {
  const url = unsubscribeUrl(input.workspaceId, input.recipientEmail);
  return [
    '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e3e6ea;',
    'color:#5c6675;font-size:12px;line-height:1.5;font-family:Arial,sans-serif">',
    escapeHtml(input.postalAddress).replace(/\n/g, "<br />"),
    "<br /><br />",
    `<a href="${url}" style="color:#5c6675">Unsubscribe</a>`,
    " — you will not be contacted again.",
    "</div>",
  ].join("");
}

export { escapeHtml };
