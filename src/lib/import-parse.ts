import { domainFromUrl, emailDomain, isValidHttpUrl, normalizeEmail, normalizeUrl } from "@/lib/email";

/**
 * Parses a pasted list of contacts.
 *
 * People paste from wildly different places — a spreadsheet column (tabs), a
 * CSV export (commas), a marketplace listing (spaces), or a plain list of
 * addresses. Rather than demand one format, this reads each line, picks out
 * whatever looks like an email and whatever looks like a website, and treats
 * the rest as a name.
 *
 * Pure and total: it never throws, and every rejected line comes back with a
 * reason so the UI can show what was skipped instead of silently dropping it.
 */

export interface ParsedRow {
  email: string;
  website: string | null;
  domain: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface SkippedRow {
  line: string;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Lines with a website but no email — these can be queued for scraping. */
  websitesOnly: string[];
  skipped: SkippedRow[];
}

// Deliberately permissive: real lists contain plus-addressing, dots, dashes and
// long TLDs. Anything that gets past here is validated properly later by the
// validation job, which checks MX records.
const EMAIL_RE = /[^\s,;<>()[\]"']+@[^\s,;<>()[\]"']+\.[a-z]{2,}/i;

/** Column headers people leave in when copying a spreadsheet. */
const HEADER_WORDS = new Set([
  "email",
  "e-mail",
  "emails",
  "mail",
  "website",
  "websites",
  "site",
  "url",
  "domain",
  "domains",
  "name",
  "contact",
  "first",
  "last",
  "firstname",
  "lastname",
]);

function looksLikeHeader(tokens: string[]): boolean {
  const words = tokens
    .map((token) => token.trim().toLowerCase().replace(/[\s_-]/g, ""))
    .filter(Boolean);
  if (words.length === 0) return false;
  return words.every((word) => HEADER_WORDS.has(word));
}

/**
 * Splits one line into fields. Tabs and commas are real separators; a bare
 * space is only treated as one when the line has no other separator, so
 * "Jane Doe, jane@x.com" keeps the name intact.
 */
function splitLine(line: string): string[] {
  const strong = line.split(/[\t,;|]+/).map((part) => part.trim()).filter(Boolean);
  if (strong.length > 1) return strong;
  return line.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

function stripWrappers(token: string): string {
  return token.replace(/^[<("']+/, "").replace(/[>)"',.]+$/, "");
}

export function parseContactImport(raw: string): ParseResult {
  const rows: ParsedRow[] = [];
  const websitesOnly: string[] = [];
  const skipped: SkippedRow[] = [];
  const seenEmails = new Set<string>();
  const seenSites = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const tokens = splitLine(line).map(stripWrappers).filter(Boolean);
    if (tokens.length === 0) continue;

    if (looksLikeHeader(tokens)) continue;

    const emailToken = tokens.find((token) => EMAIL_RE.test(token));
    const email = emailToken ? normalizeEmail(EMAIL_RE.exec(emailToken)![0]) : null;

    // A website token is anything URL-shaped that is not the email itself.
    const siteToken = tokens.find(
      (token) => token !== emailToken && !EMAIL_RE.test(token) && isValidHttpUrl(token),
    );

    if (!email) {
      if (siteToken) {
        const url = normalizeUrl(siteToken);
        if (!seenSites.has(url)) {
          seenSites.add(url);
          websitesOnly.push(url);
        }
        continue;
      }
      skipped.push({ line, reason: "No email or website found" });
      continue;
    }

    if (seenEmails.has(email)) continue;
    seenEmails.add(email);

    const website = siteToken ? normalizeUrl(siteToken) : null;
    const domain = website ? domainFromUrl(website) : emailDomain(email);

    // Whatever is left over is a name. Numbers are skipped — spreadsheet
    // exports often carry a DA/DR column that is not a person.
    const nameTokens = tokens.filter(
      (token) =>
        token !== emailToken &&
        token !== siteToken &&
        !/^[\d.,%$£€]+$/.test(token) &&
        !isValidHttpUrl(token),
    );
    const nameParts = nameTokens.join(" ").trim().split(/\s+/).filter(Boolean);

    rows.push({
      email,
      website,
      domain: domain || null,
      firstName: nameParts[0] ?? null,
      lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : null,
    });
  }

  return { rows, websitesOnly, skipped };
}
