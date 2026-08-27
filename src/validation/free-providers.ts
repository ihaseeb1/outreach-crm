/**
 * Free / consumer email providers.
 *
 * A free-provider address (gmail.com, outlook.com …) is perfectly valid to send
 * to, but it is worth knowing: for B2B link-building outreach a business-domain
 * address is a stronger signal than a personal Gmail, and the Reoon-style result
 * surfaces `is_free_email` the same way. This is informational only — it never
 * makes an address unsendable.
 */

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.in",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "naver.com",
  "hanmail.net",
  "daum.net",
  "web.de",
  "t-online.de",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "libero.it",
  "virgilio.it",
  "seznam.cz",
  "rediffmail.com",
]);

export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase().replace(/^www\./, ""));
}

/** The most common consumer domains, used for typo suggestions. */
export const POPULAR_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "gmx.com",
  "mail.com",
];
