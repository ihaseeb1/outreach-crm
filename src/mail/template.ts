import { escapeHtml, linkifyHtml } from "@/lib/html";
import type { Contact } from "@/types/db";

/**
 * `{{variable}}` templating with fallbacks: `{{first_name|there}}`.
 *
 * Unknown variables render as the fallback, or empty — never as a literal
 * "{{first_name}}" landing in a prospect's inbox.
 */

export type TemplateVars = Record<string, string | null | undefined>;

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/**
 * Renders `{{variables}}` and then spins any `{one|two|three}` choices.
 *
 * Variables run first so a `{{first_name}}` inside a spin group is already
 * resolved before the group is picked. Spintax comes second: it is the small,
 * high-value deliverability trick every serious cold-email tool has — no two
 * recipients get a byte-identical email, which is one of the patterns filters
 * score on.
 *
 * `seed` makes the pick deterministic for a recipient: the same contact always
 * gets the same variant, so a retry, a resend, or a follow-up threading under
 * the first email never silently rewrites what was sent. Omit it (compose
 * preview) and each render is a fresh random draw.
 */
export function renderTemplate(
  template: string,
  vars: TemplateVars,
  seed?: string | null,
): string {
  const substituted = template.replace(TOKEN, (_match, name: string, fallback?: string) => {
    const value = vars[name];
    if (value === null || value === undefined || value === "") {
      return fallback ?? "";
    }
    return value;
  });

  return expandSpintax(substituted, seed ? seededRandom(seed) : Math.random);
}

// Innermost first: `[^{}]` forbids nested braces, so the first match is always
// a leaf group. It requires a `|` so it never touches a `{{variable}}`.
const SPIN = /\{([^{}]*\|[^{}]*)\}/;

/**
 * Expands `{a|b|c}` to one of its options, supporting nesting. A leaf group is
 * resolved, then the next pass sees any group that contained it, and so on.
 */
export function expandSpintax(text: string, random: () => number = Math.random): string {
  let out = text;
  for (let guard = 0; guard < 200; guard += 1) {
    const match = out.match(SPIN);
    if (!match || match.index === undefined) break;
    const options = match[1]!.split("|");
    const choice = options[Math.floor(random() * options.length)] ?? options[0] ?? "";
    out = out.slice(0, match.index) + choice + out.slice(match.index + match[0].length);
  }
  return out;
}

/** Whether a template uses spintax, for the UI to preview variants. */
export function hasSpintax(template: string): boolean {
  return SPIN.test(template);
}

/** A tiny deterministic PRNG seeded from a string (mulberry32). */
function seededRandom(seed: string): () => number {
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every variable a template can use, derived from the contact. */
export function contactVars(
  contact: Pick<
    Contact,
    "email" | "first_name" | "last_name" | "website" | "domain" | "phone"
  >,
  extra: TemplateVars = {},
): TemplateVars {
  return {
    email: contact.email,
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    full_name: [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    website: contact.website ?? "",
    domain: contact.domain ?? "",
    phone: contact.phone ?? "",
    ...extra,
  };
}

/** Lists the variables a template references, for the UI to preview/validate. */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * Plain text -> simple HTML. Cold outreach performs best as plain, personal
 * mail, so this stays deliberately minimal: no images, no tracking pixels, no
 * marketing template chrome.
 */
export function textToHtml(text: string): string {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map((block) => escapeHtml(block).replace(/\n/g, "<br />"))
    .map(
      (block) =>
        `<p style="margin:0 0 16px 0;line-height:1.55">${linkifyHtml(block)}</p>`,
    )
    .join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14181f">${paragraphs}</div>`;
}
