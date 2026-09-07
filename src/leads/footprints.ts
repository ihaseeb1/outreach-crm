/**
 * Business-finding query generation for client-acquisition lead sourcing.
 *
 * Unlike discovery (which searches guest-post footprints), this turns an
 * industry + location into queries that surface the businesses themselves —
 * "dentists in Texas", "dentists Texas contact", directory listings, etc. — so
 * their sites can be scraped for a contact email and pitched.
 *
 * Pure and total so the query list can be previewed, edited and tested.
 */

export const INDUSTRY_TOKEN = "{industry}";
export const LOCATION_TOKEN = "{location}";

/**
 * Query templates. Ordered by intent strength — a plain "{industry} in
 * {location}" is the core, the rest widen the net (directories, "contact"
 * pages, and near-me phrasings that tend to list many businesses at once).
 */
export const LEAD_TEMPLATES: string[] = [
  `${INDUSTRY_TOKEN} in ${LOCATION_TOKEN}`,
  `${INDUSTRY_TOKEN} ${LOCATION_TOKEN}`,
  `best ${INDUSTRY_TOKEN} in ${LOCATION_TOKEN}`,
  `top ${INDUSTRY_TOKEN} ${LOCATION_TOKEN}`,
  `${INDUSTRY_TOKEN} ${LOCATION_TOKEN} contact`,
  `${INDUSTRY_TOKEN} ${LOCATION_TOKEN} email`,
  `${INDUSTRY_TOKEN} companies ${LOCATION_TOKEN}`,
  `${INDUSTRY_TOKEN} services ${LOCATION_TOKEN}`,
  `${INDUSTRY_TOKEN} near ${LOCATION_TOKEN}`,
  `local ${INDUSTRY_TOKEN} ${LOCATION_TOKEN}`,
  `${INDUSTRY_TOKEN} ${LOCATION_TOKEN} directory`,
  `${INDUSTRY_TOKEN} agency ${LOCATION_TOKEN}`,
  `affordable ${INDUSTRY_TOKEN} ${LOCATION_TOKEN}`,
  `${INDUSTRY_TOKEN} ${LOCATION_TOKEN} reviews`,
];

/** Templates with no location placeholder, used when no location is given. */
export const LEAD_TEMPLATES_NO_LOCATION: string[] = [
  `${INDUSTRY_TOKEN}`,
  `best ${INDUSTRY_TOKEN}`,
  `top ${INDUSTRY_TOKEN} companies`,
  `${INDUSTRY_TOKEN} services`,
  `${INDUSTRY_TOKEN} agency`,
  `${INDUSTRY_TOKEN} contact`,
  `${INDUSTRY_TOKEN} directory`,
];

function interpolate(template: string, industry: string, location: string): string {
  return template
    .split(INDUSTRY_TOKEN)
    .join(industry)
    .split(LOCATION_TOKEN)
    .join(location)
    .replace(/\s+/g, " ")
    .trim();
}

export interface LeadExpandOptions {
  /** Override the templates (the run-form editor). */
  templates?: string[];
  /** Extra industry synonyms to broaden the net (e.g. dentist, dental clinic). */
  extraIndustries?: string[];
}

/**
 * The full query list for a lead run: every template × (industry + synonyms),
 * interpolated with the location. Deduped, order-stable.
 */
export function expandLeadQueries(
  industry: string,
  location: string | null | undefined,
  opts: LeadExpandOptions = {},
): string[] {
  const primary = industry.trim();
  if (!primary) return [];
  const loc = (location ?? "").trim();

  const templates =
    opts.templates && opts.templates.length > 0
      ? opts.templates
      : loc
        ? LEAD_TEMPLATES
        : LEAD_TEMPLATES_NO_LOCATION;

  const industries = dedupe([primary, ...(opts.extraIndustries ?? [])]);

  const queries: string[] = [];
  for (const ind of industries) {
    for (const template of templates) {
      queries.push(interpolate(template, ind, loc));
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
