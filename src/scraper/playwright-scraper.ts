import { env } from "@/lib/env";
import type { FetchOutcome, Scraper } from "@/scraper/types";

/**
 * Dynamic scraper for sites that render their contact details with JavaScript.
 *
 * This CANNOT run on Vercel: a serverless function has no persistent browser and
 * the Chromium download exceeds the bundle limit. It is written against the same
 * `Scraper` interface as the static scraper so it drops into the batch runner
 * unchanged — but it must be run from a long-lived worker (see
 * `scripts/scrape-worker.ts` and the "Dynamic scraping" section of the README).
 *
 * `playwright` is an optional dependency, imported lazily, so the main app
 * builds and deploys without it.
 */
export class PlaywrightScraper implements Scraper {
  readonly name = "playwright";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private browser: any = null;

  private async launch() {
    if (this.browser) return this.browser;

    // The specifier is built at runtime so TypeScript and the bundler never try
    // to resolve an optional dependency that is absent from the serverless build.
    const moduleName = ["play", "wright"].join("");
    let playwright: { chromium: { launch: (options: unknown) => Promise<unknown> } };
    try {
      playwright = (await import(
        /* webpackIgnore: true */ moduleName
      )) as unknown as typeof playwright;
    } catch {
      throw new Error(
        "Playwright is not installed. Run `npm install playwright && npx playwright install chromium` " +
          "on the worker machine — it cannot run inside a serverless function.",
      );
    }

    this.browser = await playwright.chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    return this.browser;
  }

  async fetchPage(url: string): Promise<FetchOutcome> {
    try {
      const browser = await this.launch();
      const context = await browser.newContext({
        userAgent: env.scraperUserAgent(),
        // No images or fonts: we only want the DOM, and it is far kinder to
        // the sites we crawl.
        javaScriptEnabled: true,
      });

      const page = await context.newPage();
      await page.route("**/*", (route: { request: () => { resourceType: () => string }; abort: () => void; continue: () => void }) => {
        const type = route.request().resourceType();
        if (["image", "font", "media"].includes(type)) route.abort();
        else route.continue();
      });

      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        // Give client-rendered contact widgets a moment to appear.
        await page.waitForTimeout(1500);

        const html: string = await page.content();
        const status: number = response?.status() ?? 200;
        const finalUrl: string = page.url();

        return {
          ok: true,
          page: { url, finalUrl, status, html, contentType: "text/html" },
        };
      } finally {
        await context.close();
      }
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

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
