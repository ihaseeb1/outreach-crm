import type { GeoParams } from "@/discovery/geo";

/**
 * The search-engine abstraction. Every engine — DuckDuckGo, SearXNG, Google
 * CSE — implements this one interface, and the multi-engine router
 * (./index.ts) is the only thing the pipeline talks to. Adding or removing an
 * engine never touches pipeline code.
 */

export interface SearchHit {
  url: string;
  title: string | null;
  description: string | null;
  /** 1-based rank within this engine's results for the query. */
  position: number;
  /** Which engine produced the hit. */
  engine: string;
}

export interface SearchProvider {
  readonly name: string;
  /** False when required config (a host or key) is missing — router skips it. */
  readonly enabled: boolean;
  /**
   * Runs one query. Must never throw for an ordinary failure — return [] and
   * let the router fall back to the next engine. Reserve throwing for
   * programmer error.
   */
  search(query: string, geo: GeoParams, limit: number): Promise<SearchHit[]>;
}

/** A SearchHit with a bad/relative/non-http URL dropped, url normalized. */
export function toHit(
  raw: { url: string; title?: string | null; description?: string | null },
  position: number,
  engine: string,
): SearchHit | null {
  const url = (raw.url ?? "").trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return {
    url: parsed.toString(),
    title: raw.title?.trim() || null,
    description: raw.description?.trim() || null,
    position,
    engine,
  };
}
