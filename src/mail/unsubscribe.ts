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
  /**
   * Null when the signature above already prints it — see
   * `signatureCarriesAddress`. The address still has to be *in* the email; this
   * only decides whether the footer is the thing that puts it there.
   */
  postalAddress: string | null;
  senderName?: string | null;
}

/** CAN-SPAM footer: physical address + a working opt-out, on every campaign email. */
export function buildFooterText(input: FooterInput): string {
  const address = input.postalAddress?.trim();
  return [
    "",
    "—",
    ...(address ? [address, ""] : []),
    `Don't want to hear from me again? Unsubscribe: ${unsubscribeUrl(
      input.workspaceId,
      input.recipientEmail,
    )}`,
  ].join("\n");
}

export function buildFooterHtml(input: FooterInput): string {
  const url = unsubscribeUrl(input.workspaceId, input.recipientEmail);
  const address = input.postalAddress?.trim();
  return [
    // 16px rather than 24: with the address gone this sits directly under the
    // signature's icon row, and they read as one closing block instead of two.
    '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e3e6ea;',
    'color:#5c6675;font-size:12px;line-height:1.5;font-family:Arial,sans-serif">',
    ...(address
      ? [escapeHtml(address).replace(/\n/g, "<br />"), "<br /><br />"]
      : []),
    `<a href="${url}" style="color:#5c6675">Unsubscribe</a>`,
    " — you will not be contacted again.",
    "</div>",
  ].join("");
}

/**
 * Does the signature already print the postal address?
 *
 * CAN-SPAM wants a physical address in the message, not in a particular place.
 * Once somebody writes a proper sign-off it almost always *is* the address —
 * name, company, offices, phone — and printing the Settings value again turned
 * one signature into two, which is what this exists to stop.
 *
 * Compared on a normalised form, because the same address is never typed the
 * same way twice: "N1 7AA" against "N1  7AA", commas and line breaks moved
 * around, "UK" capitalised or not. Everything that is not a letter or a digit
 * collapses to a single space and the whole thing is lowercased, so only the
 * words and numbers have to match.
 *
 * Conservative on purpose: anything it is not sure about returns false and the
 * footer prints the address. A duplicated address is untidy; a missing one is a
 * compliance failure.
 */
export function signatureCarriesAddress(
  signature: string | null | undefined,
  postalAddress: string | null | undefined,
): boolean {
  const address = normaliseForCompare(postalAddress);
  const signed = normaliseForCompare(signature);

  // Too short to be a real address, so a chance match means nothing.
  if (address.length < 12 || !signed) return false;

  return signed.includes(address);
}

function normaliseForCompare(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { escapeHtml };
