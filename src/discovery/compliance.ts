import { isRoleAccount } from "@/lib/email";
import type { AuthorEmailStatus } from "@/types/db";

/**
 * Compliance rules for promoting an author to outreach.
 *
 * Only verified, non-suppressed, non-role (unless opted in) contacts may enter
 * a campaign. Phone handling is worldwide and advisory: region flags surface
 * the local do-not-call / privacy regime (UK TPS, US/Canada DNC, EU PECR) so
 * the operator knows the rules before dialing — nothing here auto-dials.
 *
 * Pure and total. The DB-backed suppression checks live in the route; this only
 * decides given the facts.
 */

export interface EligibilityFacts {
  email: string | null;
  emailStatus: AuthorEmailStatus;
  /** Already on a suppression list (discovery blacklist or outbound suppressions). */
  suppressed: boolean;
}

export interface EligibilityOptions {
  /** Allow role inboxes (info@, editor@ …). Off by default. */
  allowRole?: boolean;
}

export interface EligibilityDecision {
  eligible: boolean;
  reason: string | null;
}

export function authorEligibility(
  facts: EligibilityFacts,
  options: EligibilityOptions = {},
): EligibilityDecision {
  if (!facts.email) return { eligible: false, reason: "no email" };
  if (facts.emailStatus !== "verified") {
    return { eligible: false, reason: `email not verified (${facts.emailStatus})` };
  }
  if (facts.suppressed) return { eligible: false, reason: "suppressed" };
  if (!options.allowRole && isRoleAccount(facts.email)) {
    return { eligible: false, reason: "role address" };
  }
  return { eligible: true, reason: null };
}

/** ISO codes in the EU/EEA, for the PECR flag. */
const EU_EEA = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", "IS", "LI", "NO",
]);

/**
 * Advisory do-not-call / privacy flags for a phone region. Flags only — the app
 * never dials. Empty when the region is unknown or has no specific regime here.
 */
export function phoneComplianceFlags(region: string | null | undefined): string[] {
  if (!region) return [];
  const code = region.toUpperCase();
  const flags: string[] = [];
  if (code === "GB") flags.push("UK: check TPS before calling");
  if (code === "US" || code === "CA") flags.push("US/Canada: check DNC registry");
  if (EU_EEA.has(code)) flags.push("EU/EEA: PECR — prior consent for marketing calls");
  return flags;
}
