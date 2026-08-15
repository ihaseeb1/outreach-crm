import dns from "node:dns/promises";
import validator from "validator";

import { emailDomain, isRoleAccount, normalizeEmail } from "@/lib/email";
import { isDisposableDomainName } from "@/validation/disposable";
import type { ValidationStatus } from "@/types/db";

/**
 * Free email validation: syntax + MX + disposable-domain filter.
 *
 * Deliberately NOT an SMTP handshake / catch-all probe — those get your IP
 * blocked and are unreliable. True deliverability is confirmed downstream by
 * bounce handling (phase 3), which writes hard bounces to `suppressions`.
 */

export interface ValidationResult {
  email: string;
  status: ValidationStatus;
  mxHost: string | null;
  isRole: boolean;
  checkedAt: string;
  detail?: string;
}

/** Per-process MX cache — one lookup per domain per job run. */
const mxCache = new Map<string, { host: string | null; at: number }>();
const MX_CACHE_TTL_MS = 60 * 60 * 1000;

export async function resolveMxHost(domain: string): Promise<string | null> {
  const key = domain.toLowerCase();
  const cached = mxCache.get(key);
  if (cached && Date.now() - cached.at < MX_CACHE_TTL_MS) return cached.host;

  let host: string | null = null;
  try {
    const records = await dns.resolveMx(key);
    if (records.length > 0) {
      const best = [...records].sort((a, b) => a.priority - b.priority)[0];
      host = best?.exchange ?? null;
    }
  } catch {
    host = null;
  }

  mxCache.set(key, { host, at: Date.now() });
  return host;
}

export async function validateEmail(rawEmail: string): Promise<ValidationResult> {
  const email = normalizeEmail(rawEmail);
  const checkedAt = new Date().toISOString();
  const isRole = isRoleAccount(email);

  if (!email || !validator.isEmail(email)) {
    return {
      email,
      status: "invalid_syntax",
      mxHost: null,
      isRole,
      checkedAt,
      detail: "Failed RFC syntax check.",
    };
  }

  const domain = emailDomain(email);

  if (isDisposableDomainName(domain)) {
    return {
      email,
      status: "disposable",
      mxHost: null,
      isRole,
      checkedAt,
      detail: "Domain is on the disposable-provider blocklist.",
    };
  }

  const mxHost = await resolveMxHost(domain);
  if (!mxHost) {
    return {
      email,
      status: "no_mx",
      mxHost: null,
      isRole,
      checkedAt,
      detail: "Domain publishes no MX records — it cannot receive mail.",
    };
  }

  // Role accounts are the normal target for link-building outreach, so they
  // are tracked separately but still sendable.
  return {
    email,
    status: isRole ? "role_account" : "valid",
    mxHost,
    isRole,
    checkedAt,
  };
}

/** Statuses that are safe to send to (still subject to canSend()). */
export function isSendableStatus(status: ValidationStatus): boolean {
  return status === "valid" || status === "role_account";
}

export async function validateMany(
  emails: string[],
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  // Small concurrency so a big batch does not open hundreds of DNS sockets.
  const CONCURRENCY = 8;
  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const slice = emails.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(slice.map(validateEmail))));
  }
  return results;
}
