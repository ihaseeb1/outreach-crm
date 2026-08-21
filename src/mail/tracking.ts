import crypto from "node:crypto";

import { env } from "@/lib/env";
import type { TrackingMode } from "@/mail/tracking-summary";

/**
 * Open and click tracking: the signed URLs, and putting them into an email.
 *
 * Signed the same way the unsubscribe link is (HMAC over the thing being
 * claimed) so no table lookup is needed and nothing can be forged. The click
 * URL signs the destination as well as the message id — without that the
 * endpoint would be an open redirect wearing this app's domain, which is worth
 * more to a phisher than the tracking is to us.
 *
 * What this deliberately does not do:
 *
 * - **Warmup is never tracked.** Warmup mail goes between your own mailboxes.
 *   A pixel there measures nothing and adds a remote image to the traffic that
 *   is supposed to look like ordinary correspondence.
 * - **The closing block is never rewritten.** Injection runs on the message
 *   body only, before the signature and the CAN-SPAM footer are appended, so
 *   the one-click unsubscribe link stays exactly what the header promises.
 * - **`mailto:` and anchors are left alone**, along with anything already
 *   pointing at this app.
 *
 * One dependency to keep in mind: `/api/track` has to stay in
 * `PUBLIC_PREFIXES` in `lib/supabase/middleware.ts`. The pixel is fetched by
 * the recipient's mail client, which has no session, so without that entry
 * every request redirects to /login and nothing is ever recorded — silently,
 * because a mail client does not report a broken image to anyone.
 */

function signature(payload: string): string {
  return crypto
    .createHmac("sha256", env.encryptionKey())
    .update(payload)
    .digest("base64url")
    .slice(0, 32);
}

export function openSignature(messageId: string): string {
  return signature(`open:${messageId}`);
}

export function clickSignature(messageId: string, url: string): string {
  return signature(`click:${messageId}:${url}`);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function verifyOpen(messageId: string, provided: string): boolean {
  return safeEqual(provided, openSignature(messageId));
}

export function verifyClick(
  messageId: string,
  url: string,
  provided: string,
): boolean {
  return safeEqual(provided, clickSignature(messageId, url));
}

export function openPixelUrl(baseUrl: string, messageId: string): string {
  const params = new URLSearchParams({ m: messageId, s: openSignature(messageId) });
  return `${baseUrl}/api/track/open?${params.toString()}`;
}

export function clickThroughUrl(
  baseUrl: string,
  messageId: string,
  url: string,
): string {
  const params = new URLSearchParams({
    m: messageId,
    u: Buffer.from(url, "utf8").toString("base64url"),
    s: clickSignature(messageId, url),
  });
  return `${baseUrl}/api/track/click?${params.toString()}`;
}

/** Decodes the `u` parameter, refusing anything that is not an http(s) URL. */
export function decodeClickTarget(encoded: string): string | null {
  let url: string;
  try {
    url = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

const HREF = /href="([^"]+)"/g;

/**
 * Routes the body's links through the click endpoint.
 *
 * Only `href="…"` with double quotes, because that is the only form this app
 * generates — `linkifyHtml` and `textToHtml` write every anchor in the message
 * body, so there is no need to parse HTML that nobody wrote by hand. A body
 * supplied as raw `html` by a caller is treated the same way; anything the
 * regex does not match is simply left as it was, which is the safe direction.
 */
export function rewriteLinks(
  html: string,
  messageId: string,
  baseUrl: string,
): string {
  return html.replace(HREF, (match, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) return match;
    // Our own links — the unsubscribe route, the signature icons — are already
    // ours, and wrapping them would count our own footer as engagement.
    if (url.startsWith(baseUrl)) return match;
    return `href="${clickThroughUrl(baseUrl, messageId, url)}"`;
  });
}

/**
 * A 1×1 transparent GIF, styled so it cannot shift the layout of the email.
 *
 * `width`/`height` attributes as well as the CSS: Outlook ignores the style
 * attribute on images often enough that the attributes are the ones doing the
 * work.
 */
export function openPixelHtml(baseUrl: string, messageId: string): string {
  return [
    `<img src="${openPixelUrl(baseUrl, messageId)}"`,
    ' width="1" height="1" alt=""',
    ' style="width:1px;height:1px;border:0;display:block;max-height:1px;max-width:1px;overflow:hidden" />',
  ].join("");
}

export interface InjectInput {
  messageId: string;
  mode: TrackingMode;
  baseUrl?: string;
}

/** Rewrites the links in a message body, per the mode. Returns it unchanged when off. */
export function trackBody(html: string, input: InjectInput): string {
  if (input.mode !== "opens_and_clicks") return html;
  return rewriteLinks(html, input.messageId, input.baseUrl ?? env.appUrl());
}

/** Appends the pixel to a finished email. Returns it unchanged when tracking is off. */
export function trackPixel(html: string, input: InjectInput): string {
  if (input.mode === "off") return html;
  return html + openPixelHtml(input.baseUrl ?? env.appUrl(), input.messageId);
}
