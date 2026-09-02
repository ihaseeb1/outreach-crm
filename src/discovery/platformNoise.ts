import { domainFromUrl } from "@/lib/email";

/**
 * Platform noise: domains a guest-post footprint search surfaces but that are
 * never real outreach targets — social networks, UGC aggregators, video sites,
 * the search engines themselves, and the big publishing platforms where "write
 * for us" means "open a free account", not "pitch the editor".
 *
 * Matched on the registrable-ish domain and any subdomain of it.
 */
export const NOISE_DOMAINS: string[] = [
  // Social / UGC
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "reddit.com",
  "quora.com",
  "pinterest.com",
  "tiktok.com",
  "tumblr.com",
  "vk.com",
  "threads.net",
  "mastodon.social",
  // Video / media platforms
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "dailymotion.com",
  "twitch.tv",
  // Open publishing platforms (free account, not editorial outreach)
  "medium.com",
  "substack.com",
  "blogspot.com",
  "wordpress.com",
  "wix.com",
  "weebly.com",
  "livejournal.com",
  "hashnode.dev",
  "dev.to",
  "steemit.com",
  // Q&A / forums / aggregators
  "stackoverflow.com",
  "stackexchange.com",
  "producthunt.com",
  "slideshare.net",
  "scribd.com",
  "issuu.com",
  // Search engines / caches / knowledge
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "yandex.com",
  "baidu.com",
  "wikipedia.org",
  "wikimedia.org",
  "archive.org",
  "web.archive.org",
  // Marketplaces / gig / directories that pollute footprint searches
  "amazon.com",
  "ebay.com",
  "etsy.com",
  "fiverr.com",
  "upwork.com",
  "freelancer.com",
  "indeed.com",
  "glassdoor.com",
  "yelp.com",
  "trustpilot.com",
  "crunchbase.com",
];

const NOISE_SET = new Set(NOISE_DOMAINS);

/** True when the domain is a known platform, not a real publisher target. */
export function isNoiseDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!d) return true;
  if (NOISE_SET.has(d)) return true;
  // Any subdomain of a noise domain (news.google.com, foo.medium.com, …).
  return NOISE_DOMAINS.some((noise) => d.endsWith(`.${noise}`));
}

/** True when the URL's host is platform noise. */
export function isNoiseUrl(url: string): boolean {
  const domain = domainFromUrl(url);
  return domain ? isNoiseDomain(domain) : true;
}
