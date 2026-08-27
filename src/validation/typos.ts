/**
 * Typo detection for the domain half of an address.
 *
 * A surprising share of bounces are plain fat-finger mistakes made when a list
 * was typed or scraped from a page that itself had the typo: `gmial.com`,
 * `hotmial.com`, `yaho.com`. These are syntactically valid and usually have no
 * MX, so they would already be caught as `no_mx` — but naming the likely
 * intended domain turns "undeliverable, no idea why" into "you meant gmail.com",
 * which is what the Reoon result surfaces too.
 *
 * Pure string maths, so it is covered by the smoke tests.
 */

import { POPULAR_DOMAINS } from "@/validation/free-providers";

/** Classic Levenshtein edit distance, iterative and allocation-light. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insertion = (curr[j - 1] ?? 0) + 1;
      const deletion = (prev[j] ?? 0) + 1;
      const substitution = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(insertion, deletion, substitution);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length] ?? 0;
}

/**
 * Suggests the domain the user probably meant, or null when the domain is
 * already a known one or is too far from any candidate to guess.
 *
 * An exact match to a popular domain returns null (nothing to suggest). A domain
 * one or two edits away from exactly one popular domain returns that domain.
 * Business domains — anything not close to a consumer provider — return null,
 * because "you meant gmail.com" for a real company domain would be wrong.
 */
export function suggestDomain(domain: string): string | null {
  const clean = domain.toLowerCase().trim();
  if (!clean || POPULAR_DOMAINS.includes(clean)) return null;

  let best: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of POPULAR_DOMAINS) {
    const distance = editDistance(clean, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  // One or two edits is a typo; three or more is a different domain.
  if (best && bestDistance > 0 && bestDistance <= 2) return best;
  return null;
}
