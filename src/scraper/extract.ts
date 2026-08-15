import * as cheerio from "cheerio";

import { normalizeEmail, splitName } from "@/lib/email";
import type { ExtractedContact, ExtractionResult } from "@/scraper/types";

const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;

/** Image/asset filenames and tracking IDs that look like addresses but aren't. */
const JUNK_TLD_OR_EXT = /\.(png|jpe?g|gif|webp|svg|css|js|json|xml|pdf|ico|woff2?|ttf|mp4|webm)$/i;

const JUNK_DOMAINS = new Set([
  "example.com",
  "example.org",
  "domain.com",
  "yourdomain.com",
  "email.com",
  "sentry.io",
  "sentry-next.wixpress.com",
  "wixpress.com",
  "sentry.wixpress.com",
  "godaddy.com",
  "squarespace.com",
  "wordpress.com",
  "wp.com",
  "schema.org",
  "w3.org",
  "jquery.com",
  "googleapis.com",
  "gstatic.com",
  "cloudflare.com",
  "cdn.com",
]);

const JUNK_LOCAL_PATTERNS = [
  /^[0-9a-f]{16,}$/i, // hex tracking ids
  /^u003e/i,
  /^\d+x\d+$/,
  /^(image|logo|icon|banner|photo|img|bg)[-_.]?\d*$/i,
];

const SOCIAL_HOSTS: Record<string, string> = {
  "facebook.com": "facebook",
  "twitter.com": "twitter",
  "x.com": "twitter",
  "linkedin.com": "linkedin",
  "instagram.com": "instagram",
  "youtube.com": "youtube",
  "tiktok.com": "tiktok",
  "pinterest.com": "pinterest",
};

const CONTACT_LINK_HINTS = [
  "contact",
  "contact-us",
  "about",
  "about-us",
  "team",
  "our-team",
  "staff",
  "editorial",
  "editors",
  "write-for-us",
  "guest-post",
  "guest-posting",
  "advertise",
  "advertising",
  "sponsored",
  "work-with-us",
  "impressum",
  "kontakt",
];

const PHONE_REGEX =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g;

export function isJunkEmail(email: string): boolean {
  if (JUNK_TLD_OR_EXT.test(email)) return true;

  const [local, domain] = email.split("@");
  if (!local || !domain) return true;
  if (local.length > 64 || domain.length > 253) return true;
  if (JUNK_DOMAINS.has(domain.toLowerCase())) return true;
  if (domain.split(".").some((part) => part.length === 0)) return true;
  if (JUNK_LOCAL_PATTERNS.some((re) => re.test(local))) return true;
  // "name@2x.png"-style asset references.
  if (/^\d+x$/i.test(domain.split(".")[0] ?? "")) return true;
  return false;
}

/** Derives a plausible person name from a mailto label or the local part. */
function inferName(
  label: string | null,
  email: string,
): { first: string | null; last: string | null } {
  if (label) {
    const cleaned = label.replace(/\s+/g, " ").trim();
    const looksLikeName =
      cleaned.length > 1 &&
      cleaned.length <= 60 &&
      !cleaned.includes("@") &&
      /^[\p{L}'.\- ]+$/u.test(cleaned);
    if (looksLikeName) return splitName(cleaned);
  }

  const local = email.split("@")[0] ?? "";
  if (/^[a-z]+[._-][a-z]+$/i.test(local)) {
    const [first, last] = local.split(/[._-]/);
    return {
      first: capitalize(first),
      last: capitalize(last),
    };
  }
  if (/^[a-z]{2,20}$/i.test(local)) {
    return { first: capitalize(local), last: null };
  }
  return { first: null, last: null };
}

function capitalize(value: string | undefined): string | null {
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function extractFromHtml(html: string, pageUrl: string): ExtractionResult {
  const $ = cheerio.load(html);

  // Script/style bodies are full of false-positive "addresses".
  $("script, style, noscript").remove();

  const emails = new Map<string, ExtractedContact>();

  const addEmail = (raw: string, label: string | null) => {
    const email = normalizeEmail(raw.replace(/^mailto:/i, "").split("?")[0] ?? "");
    if (!email || emails.has(email) || isJunkEmail(email)) return;
    const { first, last } = inferName(label, email);
    emails.set(email, {
      email,
      firstName: first,
      lastName: last,
      sourceUrl: pageUrl,
    });
  };

  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    addEmail(href, $(el).text() || null);
  });

  const text = $("body").text();
  for (const match of text.matchAll(EMAIL_REGEX)) {
    addEmail(match[0], null);
  }
  // Some themes hide the address in data-attributes or obfuscate the @.
  const deobfuscated = html
    .replace(/\s*\[at\]\s*|\s*\(at\)\s*|\s+at\s+/gi, "@")
    .replace(/\s*\[dot\]\s*|\s*\(dot\)\s*/gi, ".");
  for (const match of deobfuscated.matchAll(EMAIL_REGEX)) {
    addEmail(match[0], null);
  }

  const phones = new Set<string>();
  $('a[href^="tel:"]').each((_, el) => {
    const value = ($(el).attr("href") ?? "").replace(/^tel:/i, "").trim();
    if (value.replace(/\D/g, "").length >= 7) phones.add(value);
  });
  if (phones.size === 0) {
    for (const match of text.matchAll(PHONE_REGEX)) {
      const digits = match[0].replace(/\D/g, "");
      if (digits.length >= 9 && digits.length <= 15) phones.add(match[0].trim());
      if (phones.size >= 3) break;
    }
  }

  const social: Record<string, string> = {};
  const candidateLinks = new Set<string>();
  const base = safeUrl(pageUrl);

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const absolute = base ? safeResolve(href, base) : null;
    if (!absolute) return;

    const host = absolute.hostname.replace(/^www\./i, "").toLowerCase();
    for (const [socialHost, key] of Object.entries(SOCIAL_HOSTS)) {
      if (host === socialHost || host.endsWith(`.${socialHost}`)) {
        if (!social[key]) social[key] = absolute.toString();
      }
    }

    if (base && absolute.hostname === base.hostname) {
      const path = absolute.pathname.toLowerCase();
      if (CONTACT_LINK_HINTS.some((hint) => path.includes(hint))) {
        absolute.hash = "";
        absolute.search = "";
        candidateLinks.add(absolute.toString());
      }
    }
  });

  return {
    emails: [...emails.values()],
    phones: [...phones].slice(0, 3),
    title: $("title").first().text().trim() || null,
    description:
      $('meta[name="description"]').attr("content")?.trim() ??
      $('meta[property="og:description"]').attr("content")?.trim() ??
      null,
    social,
    candidateLinks: [...candidateLinks],
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function safeResolve(href: string, base: URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}
