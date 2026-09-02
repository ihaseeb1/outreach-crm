/**
 * Geo targeting for SERP discovery.
 *
 * A run either targets the whole world (WORLDWIDE — no region bias, the widest
 * net) or one country. For a country we hand the search engines the parameters
 * they understand: `gl` (country), `hl` (interface language) and a Google
 * `google_domain`. Engines that ignore these simply run the query unbiased.
 *
 * Coverage is the full ISO-3166 alpha-2 set so any country can be picked; a
 * small overrides table gives the big markets their real interface language and
 * Google domain, and everything else falls back to English on google.com.
 *
 * Pure and total — never throws, and an unknown code degrades to WORLDWIDE.
 */

export const WORLDWIDE = "WORLDWIDE" as const;

export interface GeoParams {
  /** Google `gl` — the country to bias results toward (lowercase alpha-2). */
  gl?: string;
  /** Google `hl` — interface / results language. */
  hl?: string;
  /** Country Google domain, e.g. "google.co.uk". */
  google_domain?: string;
}

export interface GeoOption {
  code: string;
  name: string;
}

/** Interface-language + Google-domain overrides for the larger markets. */
const OVERRIDES: Record<string, { hl: string; domain: string }> = {
  US: { hl: "en", domain: "google.com" },
  GB: { hl: "en", domain: "google.co.uk" },
  CA: { hl: "en", domain: "google.ca" },
  AU: { hl: "en", domain: "google.com.au" },
  NZ: { hl: "en", domain: "google.co.nz" },
  IE: { hl: "en", domain: "google.ie" },
  IN: { hl: "en", domain: "google.co.in" },
  ZA: { hl: "en", domain: "google.co.za" },
  DE: { hl: "de", domain: "google.de" },
  AT: { hl: "de", domain: "google.at" },
  CH: { hl: "de", domain: "google.ch" },
  FR: { hl: "fr", domain: "google.fr" },
  BE: { hl: "fr", domain: "google.be" },
  ES: { hl: "es", domain: "google.es" },
  MX: { hl: "es", domain: "google.com.mx" },
  AR: { hl: "es", domain: "google.com.ar" },
  CO: { hl: "es", domain: "google.com.co" },
  CL: { hl: "es", domain: "google.cl" },
  IT: { hl: "it", domain: "google.it" },
  PT: { hl: "pt", domain: "google.pt" },
  BR: { hl: "pt", domain: "google.com.br" },
  NL: { hl: "nl", domain: "google.nl" },
  SE: { hl: "sv", domain: "google.se" },
  NO: { hl: "no", domain: "google.no" },
  DK: { hl: "da", domain: "google.dk" },
  FI: { hl: "fi", domain: "google.fi" },
  PL: { hl: "pl", domain: "google.pl" },
  RU: { hl: "ru", domain: "google.ru" },
  UA: { hl: "uk", domain: "google.com.ua" },
  TR: { hl: "tr", domain: "google.com.tr" },
  GR: { hl: "el", domain: "google.gr" },
  JP: { hl: "ja", domain: "google.co.jp" },
  KR: { hl: "ko", domain: "google.co.kr" },
  CN: { hl: "zh-CN", domain: "google.com" },
  TW: { hl: "zh-TW", domain: "google.com.tw" },
  HK: { hl: "zh-HK", domain: "google.com.hk" },
  ID: { hl: "id", domain: "google.co.id" },
  TH: { hl: "th", domain: "google.co.th" },
  VN: { hl: "vi", domain: "google.com.vn" },
  PH: { hl: "en", domain: "google.com.ph" },
  MY: { hl: "ms", domain: "google.com.my" },
  SG: { hl: "en", domain: "google.com.sg" },
  AE: { hl: "ar", domain: "google.ae" },
  SA: { hl: "ar", domain: "google.com.sa" },
  EG: { hl: "ar", domain: "google.com.eg" },
  IL: { hl: "he", domain: "google.co.il" },
  NG: { hl: "en", domain: "google.com.ng" },
  KE: { hl: "en", domain: "google.co.ke" },
  CZ: { hl: "cs", domain: "google.cz" },
  RO: { hl: "ro", domain: "google.ro" },
  HU: { hl: "hu", domain: "google.hu" },
};

/**
 * Full ISO-3166 alpha-2 → English country name. Used to populate the geo
 * picker; the language/domain come from OVERRIDES (English/google.com default).
 */
export const ISO_3166: Record<string, string> = {
  AD: "Andorra", AE: "United Arab Emirates", AF: "Afghanistan", AG: "Antigua and Barbuda",
  AI: "Anguilla", AL: "Albania", AM: "Armenia", AO: "Angola", AQ: "Antarctica",
  AR: "Argentina", AS: "American Samoa", AT: "Austria", AU: "Australia", AW: "Aruba",
  AX: "Åland Islands", AZ: "Azerbaijan", BA: "Bosnia and Herzegovina", BB: "Barbados",
  BD: "Bangladesh", BE: "Belgium", BF: "Burkina Faso", BG: "Bulgaria", BH: "Bahrain",
  BI: "Burundi", BJ: "Benin", BL: "Saint Barthélemy", BM: "Bermuda", BN: "Brunei",
  BO: "Bolivia", BQ: "Caribbean Netherlands", BR: "Brazil", BS: "Bahamas", BT: "Bhutan",
  BV: "Bouvet Island", BW: "Botswana", BY: "Belarus", BZ: "Belize", CA: "Canada",
  CC: "Cocos (Keeling) Islands", CD: "DR Congo", CF: "Central African Republic",
  CG: "Congo", CH: "Switzerland", CI: "Côte d'Ivoire", CK: "Cook Islands", CL: "Chile",
  CM: "Cameroon", CN: "China", CO: "Colombia", CR: "Costa Rica", CU: "Cuba",
  CV: "Cape Verde", CW: "Curaçao", CX: "Christmas Island", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DJ: "Djibouti", DK: "Denmark", DM: "Dominica", DO: "Dominican Republic",
  DZ: "Algeria", EC: "Ecuador", EE: "Estonia", EG: "Egypt", EH: "Western Sahara",
  ER: "Eritrea", ES: "Spain", ET: "Ethiopia", FI: "Finland", FJ: "Fiji",
  FK: "Falkland Islands", FM: "Micronesia", FO: "Faroe Islands", FR: "France",
  GA: "Gabon", GB: "United Kingdom", GD: "Grenada", GE: "Georgia", GF: "French Guiana",
  GG: "Guernsey", GH: "Ghana", GI: "Gibraltar", GL: "Greenland", GM: "Gambia",
  GN: "Guinea", GP: "Guadeloupe", GQ: "Equatorial Guinea", GR: "Greece",
  GS: "South Georgia", GT: "Guatemala", GU: "Guam", GW: "Guinea-Bissau", GY: "Guyana",
  HK: "Hong Kong", HM: "Heard & McDonald Islands", HN: "Honduras", HR: "Croatia",
  HT: "Haiti", HU: "Hungary", ID: "Indonesia", IE: "Ireland", IL: "Israel",
  IM: "Isle of Man", IN: "India", IO: "British Indian Ocean Territory", IQ: "Iraq",
  IR: "Iran", IS: "Iceland", IT: "Italy", JE: "Jersey", JM: "Jamaica", JO: "Jordan",
  JP: "Japan", KE: "Kenya", KG: "Kyrgyzstan", KH: "Cambodia", KI: "Kiribati",
  KM: "Comoros", KN: "Saint Kitts and Nevis", KP: "North Korea", KR: "South Korea",
  KW: "Kuwait", KY: "Cayman Islands", KZ: "Kazakhstan", LA: "Laos", LB: "Lebanon",
  LC: "Saint Lucia", LI: "Liechtenstein", LK: "Sri Lanka", LR: "Liberia", LS: "Lesotho",
  LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", LY: "Libya", MA: "Morocco",
  MC: "Monaco", MD: "Moldova", ME: "Montenegro", MF: "Saint Martin", MG: "Madagascar",
  MH: "Marshall Islands", MK: "North Macedonia", ML: "Mali", MM: "Myanmar",
  MN: "Mongolia", MO: "Macao", MP: "Northern Mariana Islands", MQ: "Martinique",
  MR: "Mauritania", MS: "Montserrat", MT: "Malta", MU: "Mauritius", MV: "Maldives",
  MW: "Malawi", MX: "Mexico", MY: "Malaysia", MZ: "Mozambique", NA: "Namibia",
  NC: "New Caledonia", NE: "Niger", NF: "Norfolk Island", NG: "Nigeria", NI: "Nicaragua",
  NL: "Netherlands", NO: "Norway", NP: "Nepal", NR: "Nauru", NU: "Niue",
  NZ: "New Zealand", OM: "Oman", PA: "Panama", PE: "Peru", PF: "French Polynesia",
  PG: "Papua New Guinea", PH: "Philippines", PK: "Pakistan", PL: "Poland",
  PM: "Saint Pierre and Miquelon", PN: "Pitcairn Islands", PR: "Puerto Rico",
  PS: "Palestine", PT: "Portugal", PW: "Palau", PY: "Paraguay", QA: "Qatar",
  RE: "Réunion", RO: "Romania", RS: "Serbia", RU: "Russia", RW: "Rwanda",
  SA: "Saudi Arabia", SB: "Solomon Islands", SC: "Seychelles", SD: "Sudan", SE: "Sweden",
  SG: "Singapore", SH: "Saint Helena", SI: "Slovenia", SJ: "Svalbard and Jan Mayen",
  SK: "Slovakia", SL: "Sierra Leone", SM: "San Marino", SN: "Senegal", SO: "Somalia",
  SR: "Suriname", SS: "South Sudan", ST: "São Tomé and Príncipe", SV: "El Salvador",
  SX: "Sint Maarten", SY: "Syria", SZ: "Eswatini", TC: "Turks and Caicos Islands",
  TD: "Chad", TF: "French Southern Territories", TG: "Togo", TH: "Thailand",
  TJ: "Tajikistan", TK: "Tokelau", TL: "Timor-Leste", TM: "Turkmenistan", TN: "Tunisia",
  TO: "Tonga", TR: "Turkey", TT: "Trinidad and Tobago", TV: "Tuvalu", TW: "Taiwan",
  TZ: "Tanzania", UA: "Ukraine", UG: "Uganda", UM: "U.S. Outlying Islands",
  US: "United States", UY: "Uruguay", UZ: "Uzbekistan", VA: "Vatican City",
  VC: "Saint Vincent and the Grenadines", VE: "Venezuela", VG: "British Virgin Islands",
  VI: "U.S. Virgin Islands", VN: "Vietnam", VU: "Vanuatu", WF: "Wallis and Futuna",
  WS: "Samoa", YE: "Yemen", YT: "Mayotte", ZA: "South Africa", ZM: "Zambia",
  ZW: "Zimbabwe",
};

/** True for a real ISO-3166 alpha-2 country code (case-insensitive). */
export function isCountryCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISO_3166, code.toUpperCase());
}

/**
 * Search parameters for a geo target.
 *
 * WORLDWIDE (and any unknown code) returns an empty object — no `gl`, so the
 * engines run the query with no country bias. A real country returns its `gl`,
 * `hl` and `google_domain`.
 */
export function getGeoParams(geo: string | null | undefined): GeoParams {
  if (!geo) return {};
  const code = geo.toUpperCase();
  if (code === WORLDWIDE) return {};
  if (!isCountryCode(code)) return {};
  const override = OVERRIDES[code];
  return {
    gl: code.toLowerCase(),
    hl: override?.hl ?? "en",
    google_domain: override?.domain ?? "google.com",
  };
}

/** Options for a geo picker: Worldwide first, then countries A→Z by name. */
export function geoOptions(): GeoOption[] {
  const countries = Object.entries(ISO_3166)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ code: WORLDWIDE, name: "Worldwide" }, ...countries];
}
