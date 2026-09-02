/**
 * Freshness scoring for active authors — recency-weighted so someone who
 * posted 2 days ago ranks above someone who posted 25 days ago. Pure and total.
 */

/**
 * 0–100 by how recently the post went out, linear across the window. Today ≈
 * 100, decaying to ~0 at `windowDays`. Anything older than the window (or with
 * no date) scores 0.
 */
export function freshnessScore(
  publishedAt: string | null | undefined,
  windowDays: number,
  now: Date = new Date(),
): number {
  if (!publishedAt) return 0;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0;

  const ageDays = (now.getTime() - t) / (24 * 60 * 60 * 1000);
  if (ageDays < 0) return 100; // future-dated: treat as brand new
  if (ageDays >= windowDays) return 0;
  return Math.round(((windowDays - ageDays) / windowDays) * 100);
}

/**
 * A short topic from a post title — strips a trailing " - Site Name" / " | Site"
 * suffix and collapses whitespace. Best-effort; returns null for an empty title.
 */
export function inferTopic(title: string | null | undefined): string | null {
  if (!title) return null;
  const cleaned = title
    .split(/\s+[|\-–—]\s+/)[0] // drop " | Site" / " - Site" suffix
    ?.replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2) return null;
  return cleaned.slice(0, 120);
}
