/**
 * Opportunity score — how worth-pursuing a discovered site is, 0–100, from
 * free signals only (no paid DR/traffic). It is additive and deterministic:
 * each signal we have positive evidence for adds points; signals we haven't
 * measured yet simply don't contribute, so the score climbs as later phases
 * enrich the same row (SERP → crawl → contact).
 *
 * Pure and total. Re-run it whenever new signals arrive and overwrite the
 * stored score.
 */

export interface OpportunitySignals {
  /** An explicit write-for-us / contribute / guest-post page was matched. */
  hasWriteForUsPage?: boolean;
  /** Best SERP rank across engines (1 = top). Lower is better. */
  bestPosition?: number | null;
  /** Days between posts, from sitemap <lastmod>. Lower = more active. */
  postCadenceDays?: number | null;
  /** Visible email/phone/contact page found. */
  hasContactInfo?: boolean;
  /** Author bios carry external do-follow links (proof they pass link equity). */
  authorBioDofollow?: boolean;
  /** Outbound links per post — a high count signals a link farm. */
  outboundLinksPerPost?: number | null;
}

/** Points each signal can contribute (they sum, then clamp to 0–100). */
const WEIGHTS = {
  writeForUs: 30,
  cadence: 25,
  contactInfo: 15,
  authorDofollow: 20,
  position: 10,
  linkFarmPenalty: 20,
} as const;

export function scoreOpportunity(signals: OpportunitySignals): number {
  let score = 0;

  if (signals.hasWriteForUsPage) score += WEIGHTS.writeForUs;

  // Cadence: <=3 days is a very active blog (full points), decaying to 0 by
  // ~30 days. Unknown cadence contributes nothing.
  const cadence = signals.postCadenceDays;
  if (typeof cadence === "number" && cadence >= 0) {
    const activity = clamp01((30 - cadence) / 27); // 3d -> 1, 30d -> 0
    score += WEIGHTS.cadence * activity;
  }

  if (signals.hasContactInfo) score += WEIGHTS.contactInfo;
  if (signals.authorBioDofollow) score += WEIGHTS.authorDofollow;

  // SERP position bonus: rank 1 -> full, decaying across the first page.
  const pos = signals.bestPosition;
  if (typeof pos === "number" && pos >= 1) {
    const rankValue = clamp01((11 - pos) / 10); // 1 -> 1, 11+ -> 0
    score += WEIGHTS.position * rankValue;
  }

  // Link-farm penalty: many outbound links per post erodes value.
  const outbound = signals.outboundLinksPerPost;
  if (typeof outbound === "number" && outbound > 50) {
    const severity = clamp01((outbound - 50) / 150); // 50 -> 0, 200+ -> 1
    score -= WEIGHTS.linkFarmPenalty * severity;
  }

  return Math.round(clamp(score, 0, 100));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
