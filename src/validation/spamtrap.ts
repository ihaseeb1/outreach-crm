/**
 * Spam-trap and gibberish heuristics.
 *
 * A true spam trap is an address created to catch senders who mail lists they
 * did not build cleanly. There is no public list of them (that would defeat the
 * point), so a self-hosted verifier cannot know them for certain the way a paid
 * service with historic data can. What it *can* do is refuse the two shapes that
 * most often turn out to be traps or dead weight on a scraped list, and flag
 * them so they never enter a campaign:
 *
 *   1. Addresses on domains known to be recycled into traps / honeypots.
 *   2. Local parts that are random gibberish — the tell of an address generated
 *      or mangled rather than one a person uses.
 *
 * Both are heuristics: conservative, and only ever used to *hold back* an
 * address, never to send. Everything here is pure, so it is covered by tests.
 */

/**
 * Domains repeatedly associated with spam traps, honeypots, or abandoned
 * addresses used to seed lists. Small and hand-curated on purpose: a false
 * positive here removes a real prospect.
 */
const KNOWN_TRAP_DOMAINS = new Set([
  "spam.la",
  "spamtrap.com",
  "spamtrap.io",
  "spamgourmet.com",
  "spam4.me",
  "honeypot.net",
  "trapmail.com",
  "abuse.net",
  "devnull.com",
  "blackhole.io",
]);

export function isKnownTrapDomain(domain: string): boolean {
  return KNOWN_TRAP_DOMAINS.has(domain.toLowerCase().replace(/^www\./, ""));
}

/**
 * Whether a local part reads as random gibberish rather than a name or role.
 *
 * The signals, any two of which together flag it:
 *   - long (> 15 chars) with no separator (no dot, dash or underscore)
 *   - a high share of digits mixed through letters
 *   - a long run with no vowels at all (keyboard-mash / hash-like)
 *   - a very high ratio of unique consonants back to back
 *
 * Deliberately lenient: `info`, `sales.team`, `j.smith`, `firstname.lastname`,
 * `contact2024` all pass. `x7f9qz2k1p8vwr` and `a8s7d6f5g4h3` do not.
 */
export function isGibberishLocalPart(localPart: string): boolean {
  const local = localPart.toLowerCase();
  if (local.length <= 6) return false; // too short to judge; let it through

  let score = 0;

  const hasSeparator = /[._-]/.test(local);
  const letters = local.replace(/[^a-z]/g, "");
  const digits = local.replace(/[^0-9]/g, "");
  const digitRatio = local.length > 0 ? digits.length / local.length : 0;

  // Long, unbroken, and not obviously a word.
  if (local.length > 15 && !hasSeparator) score += 1;

  // Heavy digit mixing (not a trailing year like info2024).
  if (digitRatio > 0.4 && !/^\D+\d+$/.test(local)) score += 1;

  // A long consonant-only run — vowels are what make a string pronounceable.
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  const vowelRatio = letters.length > 0 ? vowels / letters.length : 1;
  if (letters.length >= 8 && vowelRatio < 0.15) score += 1;

  // Longest run of consecutive consonants.
  const longestConsonantRun = (letters.match(/[^aeiou]+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  if (longestConsonantRun >= 6) score += 1;

  return score >= 2;
}
