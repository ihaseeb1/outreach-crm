import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Phone normalization — worldwide. Turns a scraped phone string into E.164 plus
 * the ISO region, using libphonenumber-js. Pure and total: an unparseable or
 * invalid number returns null rather than throwing.
 *
 * A `regionHint` (the run's target country, say) helps parse a national-format
 * number that carries no country code; an international "+…" number ignores it.
 */
export interface NormalizedPhone {
  e164: string;
  region: string | null;
}

export function normalizePhone(
  raw: string,
  regionHint?: string | null,
): NormalizedPhone | null {
  if (!raw) return null;
  const hint = regionHint ? (regionHint.toUpperCase() as CountryCode) : undefined;

  // International number first; fall back to parsing with the region hint.
  const parsed =
    parsePhoneNumberFromString(raw) ?? (hint ? parsePhoneNumberFromString(raw, hint) : undefined);

  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, region: parsed.country ?? null };
}
