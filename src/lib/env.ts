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

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  appUrl: () => optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000").replace(/\/$/, ""),

  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),

  cronSecret: () => required("CRON_SECRET"),
  encryptionKey: () => required("APP_ENCRYPTION_KEY"),

  scraperUserAgent: () =>
    optional(
      "SCRAPER_USER_AGENT",
      "OutreachCRM/1.0 (+https://example.com/bot; contact@example.com)",
    ),
  scraperCrawlDelayMs: () => optionalInt("SCRAPER_CRAWL_DELAY_MS", 1500),
  scraperMaxPagesPerSite: () => optionalInt("SCRAPER_MAX_PAGES_PER_SITE", 5),
} as const;
