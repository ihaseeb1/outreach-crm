import { env } from "@/lib/env";
import {
  crawlableUrl,
  isRetriableStatus,
  parseRetryAfter,
  retryDelayMs,
} from "@/scraper/safety";
import type { FetchOutcome, Scraper } from "@/scraper/types";

const MAX_BYTES = 2_000_000; // Don't pull huge pages into a serverless function.
const TIMEOUT_MS = 15_000;
/** Total attempts per page (1 initial + retries) for transient failures. */
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Static HTML scraper: plain fetch + a descriptive User-Agent.
 *
 * Hardened for §7: an SSRF guard refuses private / internal hosts (including
 * after a redirect), and transient failures (network errors, 429, 5xx) are
 * retried with capped back-off that honours a server's Retry-After. Handles
 * ~90% of publisher sites; JS-rendered ones need the Playwright implementation.
 */
export class StaticScraper implements Scraper {
  readonly name = "static";

  async fetchPage(url: string): Promise<FetchOutcome> {
    // Refuse to fetch a private/internal or non-http(s) URL outright.
    const guard = crawlableUrl(url);
    if (!guard.ok) {
      return { ok: false, failure: { url, status: null, error: guard.reason } };
    }

    let lastFailure: FetchOutcome & { ok: false } = {
      ok: false,
      failure: { url, status: null, error: "Not attempted" },
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.attempt(url);
      if (outcome.ok) return outcome;

      lastFailure = outcome;

      // Only retry transient failures (a network error has status null, which
      // is worth one more try; a 404 or "Not HTML" is final).
      const status = outcome.failure.status;
      const retriable = status === null || isRetriableStatus(status);
      if (!retriable || attempt === MAX_ATTEMPTS) break;

      const delay = retryDelayMs({
        attempt,
        retryAfterSeconds: outcome.failure.retryAfterSeconds ?? null,
      });
      await sleep(delay);
    }

    return lastFailure;
  }

  /** One fetch attempt, with the size cap, content-type check, and SSRF re-check. */
  private async attempt(url: string): Promise<FetchOutcome & { ok: false } | (FetchOutcome & { ok: true })> {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": env.scraperUserAgent(),
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // A public URL can 30x to an internal one; validate where we actually landed.
      if (response.url) {
        const landed = crawlableUrl(response.url);
        if (!landed.ok) {
          return {
            ok: false,
            failure: { url, status: response.status, error: `Redirected to ${landed.reason.toLowerCase()}` },
          };
        }
      }

      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            url,
            status: response.status,
            error: `HTTP ${response.status}`,
            retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
          },
        };
      }

      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        return {
          ok: false,
          failure: { url, status: response.status, error: `Not HTML (${contentType})` },
        };
      }

      const buffer = await response.arrayBuffer();
      const truncated = buffer.byteLength > MAX_BYTES
        ? buffer.slice(0, MAX_BYTES)
        : buffer;
      const html = new TextDecoder("utf-8", { fatal: false }).decode(truncated);

      return {
        ok: true,
        page: {
          url,
          finalUrl: response.url || url,
          status: response.status,
          html,
          contentType,
        },
      };
    } catch (error) {
      return {
        ok: false,
        failure: {
          url,
          status: null,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

export const defaultScraper: Scraper = new StaticScraper();
