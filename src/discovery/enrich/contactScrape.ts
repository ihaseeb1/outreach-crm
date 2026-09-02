import type { SupabaseClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

import { normalizeEmail } from "@/lib/email";
import { crawlDelayMs, fetchRobots, isAllowed } from "@/scraper/robots";
import { extractFromHtml, isJunkEmail } from "@/scraper/extract";
import { fetchCached } from "@/discovery/crawl/fetcher";

/**
 * Self-scrapes an author's destination site for contact details — email,
 * phone, socials — with no paid API. It reuses the existing extractor (mailto,
 * body text, obfuscated addresses, social links, contact-page discovery) and
 * adds a JSON-LD `ContactPoint`/`Organization` scan, which the extractor skips
 * because it strips <script> tags first.
 *
 * Fetches the homepage plus a couple of contact/about pages, politely (robots +
 * crawl delay), through the cached fetcher. Never throws.
 */

export interface ScrapedContacts {
  emails: string[];
  phones: string[];
  social: Record<string, string>;
}

const MAX_CONTACT_PAGES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scrapeContacts(
  supabase: SupabaseClient,
  domain: string,
  options: { respectRobots?: boolean } = {},
): Promise<ScrapedContacts> {
  const respectRobots = options.respectRobots ?? true;
  const origin = `https://${domain.replace(/^www\./, "")}`;

  let robots;
  try {
    robots = await fetchRobots(origin);
  } catch {
    robots = null;
  }
  const delay = robots ? crawlDelayMs(robots) : 1500;
  const allowed = (url: string) => {
    if (!respectRobots || !robots) return true;
    try {
      return isAllowed(robots, new URL(url).pathname);
    } catch {
      return false;
    }
  };

  const emails = new Set<string>();
  const phones = new Set<string>();
  const social: Record<string, string> = {};

  const visited = new Set<string>();
  const queue: string[] = [origin];
  let pages = 0;

  while (queue.length > 0 && pages < 1 + MAX_CONTACT_PAGES) {
    const url = queue.shift();
    if (!url || visited.has(url) || !allowed(url)) continue;
    visited.add(url);
    if (pages > 0) await sleep(delay);

    const outcome = await fetchCached(supabase, url);
    pages += 1;
    if (!outcome.ok) continue;

    const html = outcome.page.html;
    const extracted = extractFromHtml(html, outcome.page.finalUrl || url);
    for (const c of extracted.emails) emails.add(c.email);
    for (const p of extracted.phones) phones.add(p);
    Object.assign(social, extracted.social);

    // JSON-LD ContactPoint (skipped by the extractor, which drops scripts).
    for (const { email, phone } of jsonLdContacts(html)) {
      if (email && !isJunkEmail(email)) emails.add(email);
      if (phone) phones.add(phone);
    }

    // From the homepage only, follow a few contact/about pages.
    if (pages === 1) {
      for (const link of extracted.candidateLinks) {
        if (queue.length + pages < 1 + MAX_CONTACT_PAGES && !visited.has(link)) {
          queue.push(link);
        }
      }
    }
  }

  return {
    emails: [...emails].map(normalizeEmail).filter(Boolean),
    phones: [...phones],
    social,
  };
}

/** Emails/phones from schema.org JSON-LD ContactPoint / Organization nodes. */
function jsonLdContacts(html: string): { email: string | null; phone: string | null }[] {
  const out: { email: string | null; phone: string | null }[] = [];
  const $ = cheerio.load(html);
  $('script[type="application/ld+json"]').each((_, el) => {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      return;
    }
    walk(data, out);
  });
  return out;
}

function walk(node: unknown, out: { email: string | null; phone: string | null }[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  const email = typeof obj.email === "string" ? normalizeEmail(obj.email.replace(/^mailto:/i, "")) : null;
  const phone = typeof obj.telephone === "string" ? obj.telephone.trim() : null;
  if (email || phone) out.push({ email: email || null, phone: phone || null });
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walk(value, out);
  }
}
