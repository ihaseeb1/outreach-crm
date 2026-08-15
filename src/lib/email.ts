/** Small shared helpers for handling addresses, domains and URLs. */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

const ROLE_LOCAL_PARTS = new Set([
  "admin",
  "billing",
  "contact",
  "editor",
  "editorial",
  "enquiries",
  "enquiry",
  "guestpost",
  "help",
  "hello",
  "hi",
  "info",
  "inquiries",
  "marketing",
  "media",
  "office",
  "outreach",
  "partnership",
  "partnerships",
  "press",
  "pr",
  "sales",
  "support",
  "team",
  "webmaster",
]);

/**
 * Role accounts (info@, editor@ …) are the normal target for link-building
 * outreach, so this is informational, not disqualifying.
 */
export function isRoleAccount(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return ROLE_LOCAL_PARTS.has(local.replace(/[._-]?\d+$/, ""));
}

/** Extracts the registrable-ish domain from a URL, without the leading www. */
export function domainFromUrl(rawUrl: string): string {
  try {
    const url = new URL(normalizeUrl(rawUrl));
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Adds a scheme when missing and strips fragments so URLs dedupe cleanly. */
export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.hash = "";
    return url.toString();
  } catch {
    return withScheme;
  }
}

export function isValidHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(normalizeUrl(rawUrl));
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

/** Splits a display name into first/last, best-effort. */
export function splitName(fullName: string | null | undefined): {
  first: string | null;
  last: string | null;
} {
  if (!fullName) return { first: null, last: null };
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0] ?? null, last: null };
  return {
    first: parts[0] ?? null,
    last: parts.slice(1).join(" ") || null,
  };
}
