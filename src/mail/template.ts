import { escapeHtml } from "@/lib/html";
import type { Contact } from "@/types/db";

/**
 * `{{variable}}` templating with fallbacks: `{{first_name|there}}`.
 *
 * Unknown variables render as the fallback, or empty — never as a literal
 * "{{first_name}}" landing in a prospect's inbox.
 */

export type TemplateVars = Record<string, string | null | undefined>;

const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(TOKEN, (_match, name: string, fallback?: string) => {
    const value = vars[name];
    if (value === null || value === undefined || value === "") {
      return fallback ?? "";
    }
    return value;
  });
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
        `<p style="margin:0 0 16px 0;line-height:1.55">${linkify(block)}</p>`,
    )
    .join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#14181f">${paragraphs}</div>`;
}

function linkify(html: string): string {
  return html.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
  );
}
