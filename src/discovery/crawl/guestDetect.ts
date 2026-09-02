import * as cheerio from "cheerio";

/**
 * Guest-post detection heuristics.
 *
 * Given a fetched post, score how likely it is a *guest* post (someone
 * external published here) and pull out the author's name and the external
 * links in their bio — the trail to their own "money" site. Pure and total.
 */

export interface GuestDetection {
  /** 0–100 confidence this is a guest post. */
  score: number;
  authorName: string | null;
  /** Absolute external (off-site) links found in/near the author bio. */
  bioLinks: string[];
  /** Post title, for personalization. */
  title: string | null;
}

/** Phrases that strongly indicate a guest contribution. */
const GUEST_PHRASES = [
  "this is a guest post",
  "guest post by",
  "guest article by",
  "guest post from",
  "guest author",
  "guest contributor",
  "contributed by",
  "this article was contributed",
  "this is a contributed",
  "is a guest post",
  "written for us by",
];

/** Containers that typically hold an author bio. */
const BIO_SELECTORS = [
  ".author-bio",
  ".author-box",
  ".about-author",
  ".post-author",
  ".entry-author",
  ".author-info",
  ".author-description",
  "#author-box",
  "#about-author",
  '[class*="author-bio"]',
  '[class*="authorbio"]',
  '[itemprop="author"]',
];

const SOCIAL_HINTS = [
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "gravatar.com",
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function detectGuestPost(html: string, pageUrl: string): GuestDetection {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const sourceHost = hostOf(pageUrl);
  const bodyText = $("body").text().toLowerCase();

  let score = 0;

  // 1) Guest-intent phrases.
  const phraseHit = GUEST_PHRASES.some((p) => bodyText.includes(p));
  if (phraseHit) score += 40;

  // 2) Author name — structured elements first, then a byline phrase.
  const authorName = extractAuthor($) ?? authorFromPhrase($("body").text());
  if (authorName) score += 15;

  // 3) Author bio box + its external links.
  const bioLinks = new Set<string>();
  let hasBio = false;
  for (const selector of BIO_SELECTORS) {
    const el = $(selector).first();
    if (el.length === 0) continue;
    hasBio = true;
    el.find("a[href]").each((_, a) => {
      const href = $(a).attr("href") ?? "";
      const rel = ($(a).attr("rel") ?? "").toLowerCase();
      const abs = resolve(href, pageUrl);
      if (!abs) return;
      const host = hostOf(abs);
      if (!host || host === sourceHost) return;
      if (SOCIAL_HINTS.some((s) => host === s || host.endsWith(`.${s}`))) return;
      // Prefer dofollow, but keep nofollow as a weaker fallback.
      bioLinks.add(rel.includes("nofollow") ? `nofollow:${abs}` : abs);
    });
    break; // first matching bio container wins
  }
  if (hasBio) score += 20;
  if ([...bioLinks].some((l) => !l.startsWith("nofollow:"))) score += 25;
  else if (bioLinks.size > 0) score += 10;

  return {
    score: Math.min(100, score),
    authorName,
    bioLinks: [...bioLinks].map((l) => l.replace(/^nofollow:/, "")),
    title: $("title").first().text().trim() || null,
  };
}

function extractAuthor($: cheerio.CheerioAPI): string | null {
  const meta = $('meta[name="author"]').attr("content")?.trim();
  if (meta) return clean(meta);

  const rel = $('a[rel="author"], [rel="author"]').first().text().trim();
  if (rel) return clean(rel);

  for (const sel of [".author-name", ".author", ".byline", '[itemprop="author"]']) {
    const t = $(sel).first().text().trim();
    if (t) return clean(t);
  }

  // JSON-LD author.
  let fromLd: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (fromLd) return;
    try {
      const data = JSON.parse($(el).text());
      fromLd = ldAuthor(data);
    } catch {
      // ignore malformed JSON-LD
    }
  });
  return fromLd ? clean(fromLd) : null;
}

/** Pull a name out of a byline phrase like "guest post by Jane Smith". */
const BYLINE_RE =
  /(?:guest post by|guest article by|guest post from|written by|contributed by|guest author[:,]?|post by)\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){0,2})/;

function authorFromPhrase(text: string): string | null {
  const match = BYLINE_RE.exec(text);
  return match?.[1] ? clean(match[1]) : null;
}

function ldAuthor(data: unknown): string | null {
  const nodes = Array.isArray(data) ? data : [data];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const author = (node as { author?: unknown }).author;
    if (!author) continue;
    if (typeof author === "string") return author;
    if (Array.isArray(author)) {
      const first = author[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object" && "name" in first) {
        return String((first as { name: unknown }).name);
      }
    }
    if (typeof author === "object" && "name" in author) {
      return String((author as { name: unknown }).name);
    }
  }
  return null;
}

function clean(name: string): string | null {
  const trimmed = name
    .replace(/^\s*(by|written by|posted by|author:)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length < 2 || trimmed.length > 80) return null;
  return trimmed;
}

function resolve(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
