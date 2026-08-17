import { isRoleAccount, normalizeEmail } from "@/lib/email";

/**
 * Choosing which addresses to actually email when a site yields several.
 *
 * A crawl of one website routinely returns four or five addresses — a named
 * editor, info@, support@, a privacy contact. Emailing all of them is the
 * fastest way to look like a spammer to that domain, and it wastes daily
 * volume on the same conversation.
 *
 * So the addresses are ranked and only the best one or two are kept. Nothing is
 * deleted here: this returns the split and lets the caller decide, because
 * "which of these five is the real editor" is a judgement the operator should
 * be able to overrule.
 */

/**
 * Role mailboxes worth writing to, best first. Anything not listed scores
 * better than all of them — an unrecognised local part is usually a person's
 * name, and a named human outranks any shared inbox.
 */
const ROLE_PREFERENCE = [
  "editor",
  "editorial",
  "content",
  "press",
  "media",
  "partnerships",
  "collab",
  "collaborations",
  "marketing",
  "hello",
  "hi",
  "contact",
  "enquiries",
  "inquiries",
  "info",
  "team",
  "office",
  "admin",
  "support",
  "help",
  "sales",
  "billing",
];

/** Addresses that should never be first choice, and usually not any choice. */
const AVOID = [
  "noreply",
  "no-reply",
  "donotreply",
  "postmaster",
  "webmaster",
  "abuse",
  "privacy",
  "legal",
  "dmca",
  "unsubscribe",
  "mailer-daemon",
  "bounce",
  "bounces",
];

function localPart(email: string): string {
  return normalizeEmail(email).split("@")[0]?.replace(/[._-]?\d+$/, "") ?? "";
}

/**
 * Lower is better, so a plain sort puts the best address first.
 *
 * 0     — a named person
 * 1..n  — a useful role mailbox, in ROLE_PREFERENCE order
 * 900+  — an address to avoid
 */
export function addressRank(email: string): number {
  const local = localPart(email);
  if (!local) return 999;

  const avoidIndex = AVOID.indexOf(local);
  if (avoidIndex !== -1) return 900 + avoidIndex;

  const roleIndex = ROLE_PREFERENCE.indexOf(local);
  if (roleIndex !== -1) return 1 + roleIndex;

  // Not a known role and not on the avoid list. If isRoleAccount still thinks
  // it is a shared inbox, rank it after the known-good roles but well ahead of
  // the ones to avoid.
  if (isRoleAccount(email)) return 500;

  return 0;
}

export interface DomainCandidate {
  id: string;
  email: string;
  domain: string | null;
}

export interface DedupePlan<T extends DomainCandidate> {
  /** The best `keep` addresses per domain, in rank order. */
  keep: T[];
  /** Everything else — the extras on domains that had more than `keep`. */
  drop: T[];
}

/**
 * Splits contacts into the ones worth emailing per domain and the extras.
 *
 * Contacts with no domain are always kept: there is nothing to group them by,
 * and silently dropping them would lose data the crawler did find.
 */
export function planDomainDedupe<T extends DomainCandidate>(
  contacts: T[],
  keepPerDomain = 1,
): DedupePlan<T> {
  const keepCount = Math.max(1, keepPerDomain);
  const byDomain = new Map<string, T[]>();
  const keep: T[] = [];

  for (const contact of contacts) {
    const domain = (contact.domain ?? "").trim().toLowerCase();
    if (!domain) {
      keep.push(contact);
      continue;
    }
    const list = byDomain.get(domain) ?? [];
    list.push(contact);
    byDomain.set(domain, list);
  }

  const drop: T[] = [];

  for (const list of byDomain.values()) {
    const ranked = [...list].sort((a, b) => {
      const byRank = addressRank(a.email) - addressRank(b.email);
      // Ties broken alphabetically so the same input always splits the same
      // way — a plan the operator reviews must not shuffle between loads.
      return byRank !== 0 ? byRank : a.email.localeCompare(b.email);
    });

    keep.push(...ranked.slice(0, keepCount));
    drop.push(...ranked.slice(keepCount));
  }

  return { keep, drop };
}

/** Domains represented more than once, worst-offenders first. */
export function duplicateDomains<T extends DomainCandidate>(
  contacts: T[],
): { domain: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const contact of contacts) {
    const domain = (contact.domain ?? "").trim().toLowerCase();
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}
