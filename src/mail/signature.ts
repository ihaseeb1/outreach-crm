/**
 * The social icon row, and the optional personal sign-off above it.
 *
 * **The icons render in the footer, not here** — `buildFooterHtml` puts them
 * between the postal address and the unsubscribe line, so an email ends with one
 * closing block carrying the company's address, its links and the opt-out. An
 * earlier cut hung them under the mailbox signature instead, which put a second
 * signature on every message.
 *
 * The profiles are Orankly's own, taken from the footer of orankly.com so a
 * publisher who clicks one lands where the website would have sent them. They
 * are constants rather than another settings screen: there is one company
 * behind every mailbox in this workspace, and a free-text URL field per network
 * per mailbox would be seven chances to typo the same four links.
 *
 * What is per-mailbox is *which* of them appear — stored on `mailboxes.meta` as
 * `socials`, so no migration is needed and a mailbox that should stay plain can
 * have none.
 *
 * Everything here is pure and string-in/string-out, so the markup a publisher
 * actually receives is covered by tests rather than eyeballed once. It is also
 * free of node built-ins, so the mailbox editor can import it and preview the
 * exact block that will be sent.
 */
import { escapeHtml, linkifyHtml } from "@/lib/html";

export interface SocialProfile {
  key: SocialKey;
  /** Alt text and the plain-text label — never abbreviated. */
  label: string;
  url: string;
  /** Brand colour, used to tint the generated PNG. */
  brand: string;
}

export type SocialKey = "whatsapp" | "linkedin" | "facebook" | "instagram";

/**
 * In the order orankly.com lists them, so the signature reads like the site.
 * WhatsApp is the US sales number; the site's UK number is a `tel:` link in the
 * page body, not one of the social marks.
 */
export const SOCIAL_PROFILES: SocialProfile[] = [
  {
    key: "whatsapp",
    label: "WhatsApp",
    url: "https://wa.me/12819694177",
    brand: "#25D366",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    url: "https://www.linkedin.com/company/orankly/",
    brand: "#0A66C2",
  },
  {
    key: "facebook",
    label: "Facebook",
    url: "https://www.facebook.com/webwarner",
    brand: "#1877F2",
  },
  {
    key: "instagram",
    label: "Instagram",
    url: "https://www.instagram.com/webwarnerofficial/",
    brand: "#E4405F",
  },
];

export const SOCIAL_KEYS: SocialKey[] = SOCIAL_PROFILES.map(
  (profile) => profile.key,
);

/** Displayed size. The PNGs are drawn at 2× so they stay sharp on retina. */
const ICON_PX = 22;

/**
 * Reads `mailboxes.meta.socials`.
 *
 * A mailbox that has never been configured returns every profile: the whole
 * point of the request was that outbound mail carries them, and defaulting to
 * none would mean seven mailboxes to visit before anything changed. An explicit
 * empty array is respected — that is somebody switching them off, not an
 * unconfigured row.
 */
export function parseSocialKeys(meta: unknown): SocialKey[] {
  const raw = (meta as { socials?: unknown } | null | undefined)?.socials;
  if (!Array.isArray(raw)) return [...SOCIAL_KEYS];

  // Ordered by SOCIAL_PROFILES rather than by however they were stored, so the
  // row cannot come out shuffled, and de-duplicated by construction.
  return SOCIAL_KEYS.filter((key) => raw.includes(key));
}

export function iconUrl(baseUrl: string, key: SocialKey): string {
  return `${baseUrl.replace(/\/$/, "")}/signature/${key}.png`;
}

function profilesFor(keys: SocialKey[]): SocialProfile[] {
  const wanted = new Set(keys);
  return SOCIAL_PROFILES.filter((profile) => wanted.has(profile.key));
}

/**
 * The icon row as a table.
 *
 * A table and not a flex row because Outlook's Word renderer ignores most
 * layout CSS but has always laid out tables. `border="0"` and the explicit
 * width/height on every image are there for the same reason.
 */
export function renderSocialRowHtml(
  keys: SocialKey[],
  baseUrl: string,
): string {
  const profiles = profilesFor(keys);
  if (profiles.length === 0) return "";

  const cells = profiles
    .map((profile) => {
      const img = `<img src="${iconUrl(baseUrl, profile.key)}" width="${ICON_PX}" height="${ICON_PX}" alt="${escapeHtml(
        profile.label,
      )}" style="display:block;border:0;outline:none;text-decoration:none" />`;
      return `<td style="padding:0 8px 0 0"><a href="${profile.url}" title="${escapeHtml(
        profile.label,
      )}" style="text-decoration:none">${img}</a></td>`;
    })
    .join("");

  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0 0 0"><tr>${cells}</tr></table>`;
}

/**
 * The same row for the text/plain part.
 *
 * Named links, not bare URLs: `wa.me/12819694177` on its own tells a publisher
 * nothing about what it is, and the plain-text part is what a filter reads when
 * it decides whether the HTML part is worth trusting.
 */
export function renderSocialRowText(keys: SocialKey[]): string {
  const profiles = profilesFor(keys);
  if (profiles.length === 0) return "";
  return profiles
    .map((profile) => `${profile.label}: ${profile.url}`)
    .join("\n");
}

export interface SignatureInput {
  /** `mailboxes.signature` — plain text, may be null. */
  signature: string | null | undefined;
}

export interface RenderedSignature {
  /** Appended to the text/plain body. Empty when there is nothing to add. */
  text: string;
  /** Appended to the text/html body. Empty when there is nothing to add. */
  html: string;
}

/**
 * The personal sign-off, if there is one.
 *
 * Deliberately *not* where the social icons go. They live in the footer,
 * alongside the postal address — see `buildFooterHtml`. One closing block at the
 * end of the message, carrying the company's details and its links, is what a
 * publisher expects; a sign-off with its own icon row followed by an address
 * block with none reads as two signatures, which is exactly what it looked like.
 *
 * So this is for a genuinely personal line — "Best, Haseeb" — above that block,
 * and most mailboxes will leave it empty.
 */
export function buildSignature(input: SignatureInput): RenderedSignature {
  const signature = (input.signature ?? "").trim();
  if (!signature) return { text: "", html: "" };

  return {
    text: `\n\n${signature}`,
    html: signatureBlockHtml(signature),
  };
}

/**
 * The sign-off text itself. Deliberately not `textToHtml` — that wraps every
 * block in a 16px-bottom paragraph, and a sign-off wants to sit tight under the
 * last line of the message rather than a paragraph away from it.
 */
function signatureBlockHtml(signature: string): string {
  const body = linkifyHtml(escapeHtml(signature).replace(/\n/g, "<br />"));
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14181f;line-height:1.55">${body}</div>`;
}

/**
 * Does the mailbox signature just repeat the postal address?
 *
 * If so the signature is not printed and the footer is left to do it, because
 * the footer is the block that carries the icons and the opt-out — one closing
 * block per email. This is what stops the same sign-off appearing twice, once
 * under the body and once above the unsubscribe line.
 *
 * Compared on a normalised form, because the same address is never typed the
 * same way twice: "N1 7AA" against "N1  7AA", commas and line breaks moved
 * around, "UK" capitalised or not. Everything that is not a letter or a digit
 * collapses to a single space and the whole thing is lowercased, so only the
 * words and numbers have to match.
 *
 * Conservative on purpose: anything it is not sure about returns false, and a
 * false answer only ever means "print the sign-off as well". The footer prints
 * the address either way, so a wrong guess here can never lose the address the
 * law requires.
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
