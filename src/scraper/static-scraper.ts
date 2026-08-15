import { env } from "@/lib/env";
import type { FetchOutcome, Scraper } from "@/scraper/types";

const MAX_BYTES = 2_000_000; // Don't pull huge pages into a serverless function.
const TIMEOUT_MS = 15_000;

/**
 * Static HTML scraper: plain fetch + a descriptive User-Agent.
 * Handles ~90% of publisher sites; JS-rendered ones need the Playwright
 * implementation added in phase 7.
 */
export class StaticScraper implements Scraper {
  readonly name = "static";

  async fetchPage(url: string): Promise<FetchOutcome> {
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

      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            url,
            status: response.status,
            error: `HTTP ${response.status}`,
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
