/**
 * Footprint intelligence for guest-post discovery.
 *
 * A "footprint" is the boilerplate a site prints when it accepts contributors —
 * "write for us", "submit a guest post", a `/write-for-us/` URL. Searching a
 * niche keyword alongside these footprints surfaces sites that publish guest
 * posts. This module turns one niche into the full query list: each footprint
 * template × the niche and its synonyms.
 *
 * Everything is pure and total, and the template list and synonyms are data the
 * UI can edit before a run (Phase 6).
 */

/** The `{keyword}` placeholder every template interpolates. */
export const KEYWORD_TOKEN = "{keyword}";

/**
 * Default guest-post footprints. Ordered roughly by intent strength — an
 * explicit "write for us" page is a stronger signal than a stray "guest post"
 * mention. `inurl:` narrows to sites whose URL carries the footprint.
 */
export const FOOTPRINT_TEMPLATES: string[] = [
  `${KEYWORD_TOKEN} "write for us"`,
  `${KEYWORD_TOKEN} "write for us" + guest post`,
  `${KEYWORD_TOKEN} "become a contributor"`,
  `${KEYWORD_TOKEN} "contribute to our site"`,
  `${KEYWORD_TOKEN} "submit a guest post"`,
  `${KEYWORD_TOKEN} "submit an article"`,
  `${KEYWORD_TOKEN} "guest post guidelines"`,
  `${KEYWORD_TOKEN} "accepting guest posts"`,
  `${KEYWORD_TOKEN} "guest post by"`,
  `${KEYWORD_TOKEN} "this is a guest post"`,
  `${KEYWORD_TOKEN} "guest author"`,
  `${KEYWORD_TOKEN} "want to write for us"`,
  `${KEYWORD_TOKEN} "contributor guidelines"`,
  `${KEYWORD_TOKEN} inurl:write-for-us`,
  `${KEYWORD_TOKEN} inurl:guest-post`,
  `${KEYWORD_TOKEN} inurl:guest-contributor`,
  `${KEYWORD_TOKEN} intitle:"write for us"`,
  // Wider net — more distinct footprint phrasings surface more distinct
  // publishers, which is what lifts a run's yield into the hundreds.
  `${KEYWORD_TOKEN} "submit a post"`,
  `${KEYWORD_TOKEN} "contributing writer"`,
  `${KEYWORD_TOKEN} "guest blogging"`,
  `${KEYWORD_TOKEN} "add guest post"`,
  `${KEYWORD_TOKEN} "guest column"`,
  `${KEYWORD_TOKEN} "articles wanted"`,
  `${KEYWORD_TOKEN} "become an author"`,
  `${KEYWORD_TOKEN} "submit your article"`,
  `${KEYWORD_TOKEN} "write for me"`,
  `${KEYWORD_TOKEN} inurl:write-for-us`.replace("write-for-us", "contribute"),
  `${KEYWORD_TOKEN} inurl:submit-post`,
  `${KEYWORD_TOKEN} intitle:"guest post"`,
  `${KEYWORD_TOKEN} "guest posts wanted"`,
  `${KEYWORD_TOKEN} "now accepting guest posts"`,
];

/**
 * Niche → synonyms / adjacent topics. Deliberately broad: casting a wider net
 * of keywords is what turns "tech" into hundreds of relevant publishers. The
 * lookup is on the lowercased niche; an unknown niche just uses itself.
 */
export const NICHE_SYNONYMS: Record<string, string[]> = {
  tech: ["technology", "gadgets", "software", "IT", "electronics"],
  technology: ["tech", "gadgets", "software", "IT", "innovation"],
  saas: ["software", "cloud software", "b2b software", "tech"],
  ai: ["artificial intelligence", "machine learning", "generative ai", "tech"],
  marketing: ["digital marketing", "seo", "content marketing", "advertising", "growth"],
  seo: ["search engine optimization", "digital marketing", "link building", "content marketing"],
  business: ["entrepreneurship", "startup", "small business", "b2b"],
  finance: ["personal finance", "money", "investing", "fintech", "banking"],
  crypto: ["cryptocurrency", "bitcoin", "blockchain", "web3", "defi"],
  health: ["wellness", "fitness", "medical", "healthcare", "nutrition"],
  fitness: ["health", "workout", "gym", "bodybuilding", "wellness"],
  food: ["recipes", "cooking", "culinary", "cuisine", "foodie"],
  travel: ["tourism", "vacation", "backpacking", "adventure travel", "holidays"],
  fashion: ["style", "clothing", "apparel", "streetwear", "outfits"],
  beauty: ["skincare", "makeup", "cosmetics", "grooming"],
  home: ["home improvement", "interior design", "home decor", "diy", "gardening"],
  "real estate": ["property", "realty", "housing", "mortgage", "home buying"],
  education: ["learning", "edtech", "e-learning", "students", "teaching"],
  parenting: ["motherhood", "family", "kids", "childcare"],
  pets: ["dogs", "cats", "pet care", "animals"],
  gaming: ["video games", "esports", "gaming pc", "console gaming"],
  automotive: ["cars", "auto", "vehicles", "motoring", "ev"],
  legal: ["law", "attorney", "lawyer", "legal advice"],
  ecommerce: ["online store", "dropshipping", "shopify", "retail"],
  sustainability: ["green living", "eco-friendly", "renewable energy", "climate"],
  lifestyle: ["living", "self improvement", "productivity", "wellness"],
};

/** Replaces every `{keyword}` in a template. */
export function interpolate(template: string, keyword: string): string {
  return template.split(KEYWORD_TOKEN).join(keyword).trim();
}

/**
 * A niche expanded to itself plus its synonyms, deduped and trimmed.
 * `includeSynonyms=false` returns just the niche — the toggle on the run form.
 */
export function expandNiche(niche: string, includeSynonyms = true): string[] {
  const base = niche.trim();
  if (!base) return [];
  const out = [base];
  if (includeSynonyms) {
    for (const syn of NICHE_SYNONYMS[base.toLowerCase()] ?? []) out.push(syn);
  }
  return dedupe(out);
}

export interface ExpandOptions {
  /** Override the footprint templates (Phase 6 editor). */
  templates?: string[];
  /** Fold in niche synonyms. Defaults to true. */
  includeSynonyms?: boolean;
  /** Extra niche terms to include alongside the primary niche. */
  extraNiches?: string[];
}

/**
 * The full query list for a run: every template interpolated with every
 * (niche + synonym) term. Deduped, order-stable so the same input always
 * produces the same list for an operator to review.
 */
export function expandFootprints(niche: string, opts: ExpandOptions = {}): string[] {
  const templates =
    opts.templates && opts.templates.length > 0 ? opts.templates : FOOTPRINT_TEMPLATES;

  const keywords = dedupe([
    ...expandNiche(niche, opts.includeSynonyms ?? true),
    ...(opts.extraNiches ?? []).flatMap((n) =>
      expandNiche(n, opts.includeSynonyms ?? true),
    ),
  ]);

  const queries: string[] = [];
  for (const keyword of keywords) {
    for (const template of templates) {
      if (!template.includes(KEYWORD_TOKEN)) continue;
      queries.push(interpolate(template, keyword));
    }
  }
  return dedupe(queries);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
