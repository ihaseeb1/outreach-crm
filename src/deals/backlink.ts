import * as cheerio from "cheerio";

/**
 * Live backlink verification (spec §9), pure core.
 *
 * Given a placed page's HTML and the target URL our link should point at, decide
 * whether the link is really there, whether it is dofollow, and whether the
 * anchor text matches what was agreed. No network here — the fetch lives in the
 * orchestration layer — so this is fully unit-testable.
 */

export type LinkStatus = "found" | "missing" | "error";

export interface BacklinkVerdict {
  status: LinkStatus;
  /** True when a matching link was found and it is followable (no rel=nofollow). */
  isDofollow: boolean | null;
  /** The rel attribute of the matched link, if any. */
  rel: string | null;
  /** The anchor text of the matched link, trimmed. */
  anchorFound: string | null;
  /** True when an expected anchor was given and the found anchor contains it. */
  anchorMatches: boolean | null;
  /** The exact href that matched, for the detail line. */
  matchedHref: string | null;
  /** One-line human summary for the deal row / activity log. */
  detail: string;
}

/**
 * Canonical form of a URL for comparison: lowercased host, no scheme, no `www.`,
 * no trailing slash, no fragment. Query string is kept (a link to `/p?id=1` is
 * not the same page as `/p?id=2`). Returns null for anything unparseable.
 */
export function normalizeLinkUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    // Allow bare `example.com/path` by assuming https when no scheme is present.
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let path = url.pathname.replace(/\/+$/, ""); // drop trailing slashes
    if (path === "") path = "";
    return `${host}${path}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Two URLs point at the same place after normalisation. */
export function sameTarget(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeLinkUrl(a);
  const nb = normalizeLinkUrl(b);
  return na !== null && na === nb;
}

/** rel contains a token that makes a link non-followable. */
function relBlocksFollow(rel: string): boolean {
  const tokens = rel.toLowerCase().split(/\s+/);
  return tokens.includes("nofollow") || tokens.includes("ugc") || tokens.includes("sponsored");
}

/**
 * Scans the page for an anchor whose href points at `targetUrl`. When several
 * match, a dofollow one wins over a nofollow one (that is the link that carries
 * value). Resolves relative hrefs against `pageUrl` so `/our-page` matches a
 * target on the same host.
 */
export function parseBacklink(
  html: string,
  opts: { targetUrl: string; anchorText?: string | null; pageUrl?: string | null },
): BacklinkVerdict {
  const $ = cheerio.load(html);
  const wantAnchor = opts.anchorText?.trim().toLowerCase() || null;

  interface Match {
    href: string;
    rel: string | null;
    anchor: string;
    dofollow: boolean;
  }
  const matches: Match[] = [];

  $("a[href]").each((_, el) => {
    const rawHref = $(el).attr("href") ?? "";
    if (!rawHref) return;
    // Resolve relative links against the page they were found on.
    let absolute = rawHref;
    if (opts.pageUrl && !/^https?:\/\//i.test(rawHref)) {
      try {
        absolute = new URL(rawHref, opts.pageUrl).toString();
      } catch {
        absolute = rawHref;
      }
    }
    if (!sameTarget(absolute, opts.targetUrl)) return;

    const rel = $(el).attr("rel") ?? null;
    matches.push({
      href: absolute,
      rel,
      anchor: $(el).text().trim(),
      dofollow: rel ? !relBlocksFollow(rel) : true,
    });
  });

  if (matches.length === 0) {
    return {
      status: "missing",
      isDofollow: null,
      rel: null,
      anchorFound: null,
      anchorMatches: wantAnchor ? false : null,
      matchedHref: null,
      detail: "No link to the target URL was found on the page.",
    };
  }

  // Prefer a dofollow match; among those, prefer one whose anchor matches.
  const best =
    matches.find((m) => m.dofollow && (!wantAnchor || m.anchor.toLowerCase().includes(wantAnchor))) ??
    matches.find((m) => m.dofollow) ??
    matches[0]!;

  const anchorMatches = wantAnchor
    ? best.anchor.toLowerCase().includes(wantAnchor)
    : null;

  const parts = [
    best.dofollow ? "Found (dofollow)" : `Found but ${best.rel ?? "nofollow"}`,
  ];
  if (wantAnchor) {
    parts.push(anchorMatches ? "anchor matches" : `anchor differs ("${best.anchor}")`);
  }

  return {
    status: "found",
    isDofollow: best.dofollow,
    rel: best.rel,
    anchorFound: best.anchor || null,
    anchorMatches,
    matchedHref: best.href,
    detail: parts.join(" · "),
  };
}
