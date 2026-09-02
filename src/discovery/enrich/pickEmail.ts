import { addressRank } from "@/lib/domain-dedupe";
import { emailDomain, normalizeEmail } from "@/lib/email";

/**
 * Chooses the single best contact email for an author's destination site.
 *
 * Prefers an address on the destination domain over an off-domain one (an
 * author's own site should carry their own address), and within each group
 * ranks by the shared address-quality heuristic (a named person beats a role
 * inbox beats a no-reply). Pure and total.
 */
export interface EmailPick {
  email: string;
  onDomain: boolean;
}

export function pickBestEmail(
  emails: string[],
  destinationDomain: string,
): EmailPick | null {
  const dest = destinationDomain.toLowerCase().replace(/^www\./, "");
  const seen = new Set<string>();
  const onDomain: string[] = [];
  const offDomain: string[] = [];

  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const domain = emailDomain(email);
    if (domain === dest || domain.endsWith(`.${dest}`)) onDomain.push(email);
    else offDomain.push(email);
  }

  const best = (list: string[]): string | null =>
    list.length === 0
      ? null
      : [...list].sort(
          (a, b) => addressRank(a) - addressRank(b) || a.localeCompare(b),
        )[0]!;

  const onBest = best(onDomain);
  if (onBest) return { email: onBest, onDomain: true };
  const offBest = best(offDomain);
  if (offBest) return { email: offBest, onDomain: false };
  return null;
}
