import { domainFromUrl } from "@/lib/email";

/**
 * Turns an author's bio links into their destination ("money") site.
 *
 * The bio of a guest post usually links back to the author's own site — that is
 * the target for outreach. This picks the best candidate from the bio links and
 * reduces it to a root domain, skipping the publisher's own domain and obvious
 * non-targets. Pure: redirect-following happens in the handler, which then calls
 * `destinationFromResolved` on the final URL.
 */

const NON_TARGET_HINTS = [
  "wikipedia.org",
  "amazon.",
  "goodreads.com",
  "medium.com",
  "substack.com",
  "gravatar.com",
  "about.me",
  "linktr.ee",
];

/**
 * The best destination candidate URL to resolve, or null. Prefers the first
 * external link (bio links are pre-filtered to off-site, dofollow-first).
 */
export function pickDestinationLink(
  bioLinks: string[],
  sourceDomain: string,
): string | null {
  const source = sourceDomain.toLowerCase().replace(/^www\./, "");
  for (const link of bioLinks) {
    const domain = domainFromUrl(link);
    if (!domain) continue;
    if (domain === source) continue;
    if (NON_TARGET_HINTS.some((h) => domain.includes(h))) continue;
    return link;
  }
  return null;
}

/**
 * Reduce a (possibly redirect-resolved) URL to a destination root domain,
 * rejecting it when it collapses back to the source publisher.
 */
export function destinationFromResolved(
  resolvedUrl: string,
  sourceDomain: string,
): string | null {
  const domain = domainFromUrl(resolvedUrl);
  if (!domain) return null;
  const source = sourceDomain.toLowerCase().replace(/^www\./, "");
  if (domain === source) return null;
  if (NON_TARGET_HINTS.some((h) => domain.includes(h))) return null;
  return domain;
}
