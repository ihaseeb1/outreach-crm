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
} as const;
