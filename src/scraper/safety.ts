/**
 * Crawler hardening (spec §7).
 *
 * The scraper fetches arbitrary, user-supplied URLs from inside a serverless
 * function that can reach the platform's own network. Two dangers follow:
 * server-side request forgery (a crawl aimed at `169.254.169.254` or
 * `localhost` to read cloud metadata / internal services), and flaky remote
 * hosts wasting the function's whole time budget on one dead page. This module
 * is the pure core of the defence — host blocking and retry/back-off maths —
 * kept side-effect-free so it can be unit-tested without a network.
 */

/** IPv4 literals that must never be crawled (private, loopback, link-local). */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((n) => n > 255)) return false; // not a valid IPv4
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 0 || a === 10 || a === 127) return true; // this-host / private / loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** IPv6 literals that must never be crawled (loopback, ULA, link-local). */
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local (fc00::/7)
  // IPv4-mapped (::ffff:10.0.0.1) — fall through to the IPv4 check.
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

/**
 * True for any host the crawler must refuse: loopback names, internal TLDs, and
 * private / link-local IP literals (v4 and v6). Case-insensitive; brackets are
 * stripped so a URL's `[::1]` hostname is recognised.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase().trim();
  if (!host) return true;
  if (host === "localhost" || host === "ip6-localhost") return true;
  if (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan")
  ) {
    return true;
  }
  if (isPrivateIPv4(host)) return true;
  if (host.includes(":") && isPrivateIPv6(host)) return true;
  return false;
}

export type CrawlableResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * Validates a URL is safe to fetch: a real http(s) URL whose host is not
 * private/internal. Used on the seed URL, on every followed link, and on the
 * final URL after redirects (so a public URL cannot 302 the crawler inward).
 */
export function crawlableUrl(raw: string): CrawlableResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Unsupported scheme (${url.protocol.replace(":", "")})` };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: "Blocked host (private or internal address)" };
  }
  return { ok: true, url };
}

/** HTTP statuses worth a retry: rate-limit, request-timeout, and 5xx. */
export function isRetriableStatus(status: number | null | undefined): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Parses a `Retry-After` header (delta-seconds or an HTTP date) into a
 * non-negative seconds value, or null when absent/unparseable. `now` is
 * injectable so the date branch is testable.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, (when - now) / 1000);
  return null;
}

/**
 * Back-off before the next attempt. A server-provided Retry-After wins (capped
 * at `maxMs`); otherwise exponential from `baseMs`. Deterministic — no jitter —
 * so the retry ceiling is predictable and the logic is unit-testable.
 */
export function retryDelayMs(opts: {
  attempt: number; // 1 = first retry
  retryAfterSeconds?: number | null;
  baseMs?: number;
  maxMs?: number;
}): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30_000;
  if (
    opts.retryAfterSeconds != null &&
    Number.isFinite(opts.retryAfterSeconds) &&
    opts.retryAfterSeconds >= 0
  ) {
    return Math.min(opts.retryAfterSeconds * 1000, max);
  }
  const exp = base * 2 ** Math.max(0, opts.attempt - 1);
  return Math.min(exp, max);
}

/**
 * Whether the crawler should obey robots.txt Disallow rules for a workspace.
 * Defaults to true — robots is respected unless the workspace has explicitly
 * turned it off (for sites it owns or has permission to crawl). Crawl-delay and
 * the politeness floor are always honoured regardless.
 */
export function resolveRespectRobots(
  settings: Record<string, unknown> | null | undefined,
): boolean {
  return settings?.respect_robots === false ? false : true;
}
