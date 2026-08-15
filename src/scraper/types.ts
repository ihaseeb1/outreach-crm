/**
 * Scraper abstraction. The static implementation (fetch + cheerio) ships in
 * phase 1; a Playwright implementation for JS-rendered sites can be dropped in
 * later (phase 7) without touching callers — it just needs a persistent worker,
 * which serverless functions cannot provide.
 */

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  contentType: string | null;
}

export interface FetchFailure {
  url: string;
  status: number | null;
  error: string;
}

export type FetchOutcome =
  | { ok: true; page: FetchedPage }
  | { ok: false; failure: FetchFailure };

export interface Scraper {
  readonly name: string;
  fetchPage(url: string): Promise<FetchOutcome>;
}

export interface ExtractedContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  sourceUrl: string;
}

export interface ExtractionResult {
  emails: ExtractedContact[];
  phones: string[];
  title: string | null;
  description: string | null;
  social: Record<string, string>;
  /** Same-host URLs worth following (contact/about/write-for-us pages). */
  candidateLinks: string[];
}
