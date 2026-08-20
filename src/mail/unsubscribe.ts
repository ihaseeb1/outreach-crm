import crypto from "node:crypto";

import { env } from "@/lib/env";
import { normalizeEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import {
  renderSocialRowHtml,
  renderSocialRowText,
  type SocialKey,
} from "@/mail/signature";

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
  /**
   * Social icons, rendered inside this block between the address and the
   * opt-out. They belong here rather than under a sign-off higher up: this is
   * the message's one closing block, and splitting the company's details from
   * its links puts two signatures on every email.
   */
  socials?: SocialKey[];
  /** Absolute origin the icon PNGs are served from. Needed if `socials` is set. */
  baseUrl?: string;
  senderName?: string | null;
}

/**
 * CAN-SPAM footer: physical address, the company's links, and a working opt-out.
 * On every campaign email — warmup passes `includeFooter: false` and gets none
 * of it.
 */
export function buildFooterText(input: FooterInput): string {
  const socials = renderSocialRowText(input.socials ?? []);
  return [
    // Two blank lines before the rule. With no sign-off in between, one left the
    // last sentence of the message sitting directly on top of the divider.
    "",
    "",
    "—",
    input.postalAddress.trim(),
    ...(socials ? ["", socials] : []),
    "",
    `Don't want to hear from me again? Unsubscribe: ${unsubscribeUrl(
      input.workspaceId,
      input.recipientEmail,
    )}`,
  ].join("\n");
}

export function buildFooterHtml(input: FooterInput): string {
  const url = unsubscribeUrl(input.workspaceId, input.recipientEmail);
  const socials =
    input.socials && input.baseUrl
      ? renderSocialRowHtml(input.socials, input.baseUrl)
      : "";

  return [
    '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e3e6ea;',
    'color:#5c6675;font-size:12px;line-height:1.5;font-family:Arial,sans-serif">',
    escapeHtml(input.postalAddress.trim()).replace(/\n/g, "<br />"),
    socials,
    // The icon row brings its own top margin, so the gap before the opt-out only
    // needs one break after it rather than the two a bare address needs.
    socials ? "<br />" : "<br /><br />",
    `<a href="${url}" style="color:#5c6675">Unsubscribe</a>`,
    " — you will not be contacted again.",
    "</div>",
  ].join("");
}

export { escapeHtml };
