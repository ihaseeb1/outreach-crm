import { domainFromUrl } from "@/lib/email";

/**
 * "Is this domain still available to work, or have I already touched it?"
 *
 * The operator pastes a list of websites; we check each root domain against the
 * whole workspace — deals, contacts (and their pipeline stage / suppression),
 * the prospecting queue, discovery results and the publisher list — and report
 * which are fresh (available) and which are already in the pipeline, and where.
 *
 * These helpers are pure so the parsing and the verdict logic can be smoke
 * tested; the Supabase queries live in the API route.
 */

export type AvailabilitySource =
  | "deal"
  | "contact"
  | "website"
  | "discovery"
  | "publisher";

export interface AvailabilityHit {
  source: AvailabilitySource;
  detail: string;
}

export interface DomainVerdict {
  domain: string;
  available: boolean;
  hits: AvailabilityHit[];
}

/**
 * Parse a pasted blob (newlines, commas, spaces, full URLs, with or without
 * scheme/www) into a deduped list of root domains. Anything that doesn't
 * resolve to a hostname is dropped.
 */
export function parseDomainList(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of input.split(/[\s,;]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const domain = domainFromUrl(trimmed);
    if (!domain || !domain.includes(".")) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

/**
 * Fold the per-source matches into one verdict per requested domain, preserving
 * request order. A domain with no hits anywhere is `available`. Hits are ordered
 * strongest-signal first (a deal outranks a bare prospecting-queue row).
 */
export function buildVerdicts(
  domains: string[],
  hitsByDomain: Map<string, AvailabilityHit[]>,
): DomainVerdict[] {
  const rank: Record<AvailabilitySource, number> = {
    deal: 0,
    contact: 1,
    publisher: 2,
    discovery: 3,
    website: 4,
  };
  return domains.map((domain) => {
    const hits = (hitsByDomain.get(domain) ?? [])
      .slice()
      .sort((a, b) => rank[a.source] - rank[b.source]);
    return { domain, available: hits.length === 0, hits };
  });
}
