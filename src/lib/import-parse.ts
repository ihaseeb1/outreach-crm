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

/**
 * Pairs two pasted columns — websites in one box, emails in the other —
 * matching them line by line.
 *
 * This is what copying two columns out of a spreadsheet actually gives you, so
 * it saves reformatting every row into "site, email" by hand.
 *
 * Blank lines are kept while pairing, because a blank cell in the middle of a
 * spreadsheet column is meaningful: dropping it would silently shift every
 * later email onto the wrong website. Only trailing blanks are trimmed.
 */
export function pairColumns(websitesRaw: string, emailsRaw: string): ParseResult {
  const sites = trimTrailingBlanks(websitesRaw.split(/\r?\n/).map((line) => line.trim()));
  const mails = trimTrailingBlanks(emailsRaw.split(/\r?\n/).map((line) => line.trim()));

  // A header on either column would otherwise pair "Email" with the first site.
  if (looksLikeHeader([sites[0] ?? ""]) && looksLikeHeader([mails[0] ?? ""])) {
    sites.shift();
    mails.shift();
  } else if (mails.length === 0 && looksLikeHeader([sites[0] ?? ""])) {
    sites.shift();
  } else if (sites.length === 0 && looksLikeHeader([mails[0] ?? ""])) {
    mails.shift();
  }

  const rows: ParsedRow[] = [];
  const websitesOnly: string[] = [];
  const skipped: SkippedRow[] = [];
  const seenEmails = new Set<string>();
  const seenSites = new Set<string>();

  const length = Math.max(sites.length, mails.length);

  for (let index = 0; index < length; index += 1) {
    const siteCell = stripWrappers(sites[index] ?? "");
    const mailCell = stripWrappers(mails[index] ?? "");

    const emailMatch = mailCell ? EMAIL_RE.exec(mailCell) : null;
    const email = emailMatch ? normalizeEmail(emailMatch[0]) : null;
    const site = siteCell && isValidHttpUrl(siteCell) ? normalizeUrl(siteCell) : null;

    if (!email) {
      // An address that was typed but cannot be used is always reported, even
      // when the website on the same row is fine and gets queued — otherwise
      // the contact they meant to add disappears without a word.
      if (mailCell) {
        skipped.push({
          line: `row ${index + 1}: ${mailCell}`,
          reason: "Not a valid email address",
        });
      }

      if (site) {
        if (!seenSites.has(site)) {
          seenSites.add(site);
          websitesOnly.push(site);
        }
      } else if (siteCell && !mailCell) {
        skipped.push({
          line: `row ${index + 1}: ${siteCell}`,
          reason: "Not a valid website",
        });
      }
      continue;
    }

    if (seenEmails.has(email)) continue;
    seenEmails.add(email);

    rows.push({
      email,
      website: site,
      domain: (site ? domainFromUrl(site) : emailDomain(email)) || null,
      firstName: null,
      lastName: null,
    });
  }

  return { rows, websitesOnly, skipped };
}

function trimTrailingBlanks(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy;
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
