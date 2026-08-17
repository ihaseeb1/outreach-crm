/** Naming for duplicated campaigns. Pure, so it can be tested directly. */

export const MAX_CAMPAIGN_NAME = 160;

/** " (copy)" or " (copy 3)" at the end of a name. */
const COPY_SUFFIX = /\s*\(copy(?:\s+(\d+))?\)$/i;

/**
 * Names the copy of a campaign.
 *
 * Duplicating a duplicate numbers the copy rather than stacking suffixes:
 * "Outreach (copy)" copies to "Outreach (copy 2)", never
 * "Outreach (copy) (copy)". Names are not unique in the database, but two rows
 * reading the same in a list are indistinguishable to the person choosing one.
 */
export function copyName(base: string, existing: string[]): string {
  const root = base.replace(COPY_SUFFIX, "").trim() || "Campaign";
  const taken = new Set(
    existing.map((name) => name.trim().toLowerCase()).filter(Boolean),
  );

  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? " (copy)" : ` (copy ${attempt})`;
    // The column caps at 160 characters, so a long name loses its tail rather
    // than its suffix — the suffix is the part that says what this row is.
    const stem = root.slice(0, MAX_CAMPAIGN_NAME - suffix.length).trim();
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
