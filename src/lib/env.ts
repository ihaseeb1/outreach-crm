/**
 * Central env access. Every secret comes from here so nothing is hardcoded
 * and missing config fails loudly at the call site rather than silently.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * First non-empty of several names.
 *
 * The Supabase↔Vercel integration injects its own variable names
 * (SUPABASE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, …) which differ
 * from the ones in .env.example. Accepting both means the integration can be
 * used as-is, and a hand-set value still wins when present.
 */
function firstOf(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value;
  }
  throw new Error(
    `Missing required environment variable. Set one of: ${names.join(", ")}. See .env.example.`,
  );
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  appUrl: () => optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000").replace(/\/$/, ""),

  supabaseUrl: () => firstOf("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"),
  supabaseAnonKey: () =>
    firstOf(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_ANON_KEY",
      "SUPABASE_PUBLISHABLE_KEY",
    ),
  supabaseServiceRoleKey: () =>
    firstOf("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"),

  cronSecret: () => required("CRON_SECRET"),
  encryptionKey: () => required("APP_ENCRYPTION_KEY"),

  // Registration controls (spec §5.1). Both default to the safe setting: new
  // accounts must be approved, and registration is open. Set SIGNUPS_OPEN=false
  // to close it entirely; SIGNUPS_REQUIRE_APPROVAL=false to auto-activate.
  signupsOpen: () => optional("SIGNUPS_OPEN", "true") !== "false",
  signupsRequireApproval: () =>
    optional("SIGNUPS_REQUIRE_APPROVAL", "true") !== "false",

  scraperUserAgent: () =>
    optional(
      "SCRAPER_USER_AGENT",
      "OutreachCRM/1.0 (+https://example.com/bot; contact@example.com)",
    ),
  scraperCrawlDelayMs: () => optionalInt("SCRAPER_CRAWL_DELAY_MS", 1500),
  scraperMaxPagesPerSite: () => optionalInt("SCRAPER_MAX_PAGES_PER_SITE", 5),

  // ----- Discovery & Prospecting (migration 0016). All optional: the base
  // build needs none of these — DuckDuckGo works with no key or host. -----

  /** Enabled search engines, in round-robin order. csv, e.g. "duckduckgo,searxng". */
  searchEngines: () =>
    optional("SEARCH_ENGINES", "duckduckgo")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  /** Base URL of a self-hosted SearXNG instance, e.g. http://localhost:8080. */
  searxngUrl: () => optional("SEARXNG_URL", "").replace(/\/$/, ""),
  /** Optional free-tier Google Custom Search key + engine id. */
  googleCseKey: () => optional("GOOGLE_CSE_KEY", ""),
  googleCseCx: () => optional("GOOGLE_CSE_CX", ""),
  /** "Active author" recency window, in days. */
  activeAuthorWindowDays: () => optionalInt("ACTIVE_AUTHOR_WINDOW_DAYS", 30),
  /** Cost guard: hard cap on search queries per discovery run. */
  maxSearchQueriesPerRun: () => optionalInt("MAX_SEARCH_QUERIES_PER_RUN", 300),
  /**
   * How many results to pull per query (across pages). Each keyless page holds
   * ~25–50, so 40 pulls one or two pages; raise it (worker path) to fetch deeper
   * for a bigger haul per run. This is what turns a run from ~17 sites into the
   * hundreds when paired with the full footprint × synonym query list.
   */
  resultsPerQuery: () => optionalInt("DISCOVERY_RESULTS_PER_QUERY", 40),
  /** Crawler UA — falls back to the scraper UA so there is one identity. */
  crawlerUserAgent: () =>
    process.env.CRAWLER_USER_AGENT ||
    process.env.SCRAPER_USER_AGENT ||
    "OutreachCRM/1.0 (+https://example.com/bot; contact@example.com)",
  /** Politeness floor between fetches to the same host, in ms. */
  perHostDelayMs: () => optionalInt("PER_HOST_DELAY_MS", 4000),
  /**
   * Set by the local worker (scripts/discovery-worker.ts). Keyless engines
   * (DuckDuckGo/Bing) work from a residential IP but are blocked from cloud
   * datacenters, so the Vercel-side runners defer DDG-only runs to the local
   * worker, which sets this flag.
   */
  discoveryLocal: () => process.env.DISCOVERY_LOCAL === "1",
} as const;
