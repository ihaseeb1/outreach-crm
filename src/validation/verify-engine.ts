import dns from "node:dns/promises";
import validator from "validator";

import { emailDomain, isRoleAccount, normalizeEmail } from "@/lib/email";
import { isDisposableDomainName } from "@/validation/disposable";
import { isFreeEmailDomain } from "@/validation/free-providers";
import { isGibberishLocalPart, isKnownTrapDomain } from "@/validation/spamtrap";
import { suggestDomain } from "@/validation/typos";
import { probeMailbox, type SmtpProbeResult } from "@/validation/smtp-probe";
import type { ValidationStatus } from "@/types/db";

/**
 * The in-house email verification engine — the Reoon-style verifier, built from
 * our own checks with no third-party API.
 *
 * Two modes, exactly like the tool it is modelled on:
 *
 *   quick — syntax, disposable, MX, role, free-provider, typo and gibberish
 *           heuristics. Fast (~sub-second), runs anywhere including Vercel and
 *           the cron. Cannot confirm an individual mailbox exists, so a clean
 *           address comes back `valid`, meaning "everything checkable is good".
 *
 *   power — everything in quick, plus a real SMTP conversation with the MX to
 *           confirm the mailbox exists and detect catch-all / full / disabled.
 *           This is what actually drives the bounce rate down. It needs outbound
 *           port 25, which Vercel and GitHub Actions block, so power mode is run
 *           by `scripts/verify-worker.ts` on a box that allows it. When the port
 *           is blocked the SMTP step degrades to "indeterminate" and the address
 *           keeps its quick verdict — a blocked environment never writes off a
 *           good address.
 *
 * The result shape mirrors the fields the reference tool returns, so the UI can
 * show the same detail (is_valid_syntax, mx_accepts_mail, is_catch_all, …) and
 * an `overall_score` out of 100.
 */

export type VerificationMode = "quick" | "power";

export interface VerificationResult {
  email: string;
  username: string;
  domain: string;
  status: ValidationStatus;
  /** 0–100. Higher is safer to send to. */
  overallScore: number;
  isSafeToSend: boolean;
  isValidSyntax: boolean;
  isDisposable: boolean;
  isRoleAccount: boolean;
  isFreeEmail: boolean;
  mxAcceptsMail: boolean;
  mxRecords: string[];
  /** The MX lookup failed transiently — the verdict is a "retry", not "no MX". */
  mxLookupFailed: boolean;
  /** Power mode only; null in quick mode or when the SMTP step could not run. */
  canConnectSmtp: boolean | null;
  isCatchAll: boolean | null;
  hasInboxFull: boolean | null;
  isDisabled: boolean | null;
  isDeliverable: boolean | null;
  isSpamtrap: boolean;
  /** If the domain looks like a typo, the domain the user probably meant. */
  didYouMean: string | null;
  mode: VerificationMode;
  checkedAt: string;
  detail: string;
}

/** Statuses that are safe to enrol and send to (still subject to canSend()). */
const SENDABLE = new Set<ValidationStatus>([
  "valid",
  "safe",
  "role_account",
  "catch_all",
]);

export function isSendableStatus(status: ValidationStatus): boolean {
  return SENDABLE.has(status);
}

/**
 * Statuses that mean "undeliverable — remove it". These are *permanent* failures
 * that cause bounces or reputation damage, and (per the user's choice) are
 * deleted from the list and added to the suppression list automatically.
 *
 * `inbox_full` is deliberately NOT here: a mailbox over quota today is a real,
 * live recipient that may be receiving again tomorrow, so deleting it would lose
 * a genuine contact. It is held (not sent to, re-checked later) instead — see
 * `isHoldStatus`.
 */
const UNDELIVERABLE = new Set<ValidationStatus>([
  "invalid",
  "invalid_syntax",
  "no_mx",
  "disposable",
  "spamtrap",
  "disabled",
]);

export function isUndeliverableStatus(status: ValidationStatus): boolean {
  return UNDELIVERABLE.has(status);
}

/**
 * Uncertain / temporary statuses: not safe to send yet, but not deleted either.
 * They are kept and re-queued for a deeper check.
 */
const HOLD = new Set<ValidationStatus>(["unknown", "inbox_full"]);

export function isHoldStatus(status: ValidationStatus): boolean {
  return HOLD.has(status);
}

/** Per-process MX cache — one lookup per domain per job run. */
const mxCache = new Map<string, { records: string[]; at: number }>();
const MX_CACHE_TTL_MS = 60 * 60 * 1000;

export interface MxLookup {
  records: string[];
  /**
   * True when the lookup itself failed transiently (timeout, SERVFAIL, network)
   * rather than the domain genuinely having no MX. This distinction is critical:
   * a genuine no-MX is undeliverable and gets the contact removed, but a
   * transient failure must NOT — otherwise one flaky DNS moment deletes good
   * contacts (and, with the cache, every contact on that domain for an hour).
   */
  failed: boolean;
}

/** DNS error codes that mean "the domain has no MX", not "the lookup broke". */
const DEFINITIVE_NO_MX = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);

export async function lookupMx(domain: string): Promise<MxLookup> {
  const key = domain.toLowerCase();
  const cached = mxCache.get(key);
  if (cached && Date.now() - cached.at < MX_CACHE_TTL_MS) {
    return { records: cached.records, failed: false };
  }

  try {
    const mx = await dns.resolveMx(key);
    const records = [...mx]
      .sort((a, b) => a.priority - b.priority)
      .map((record) => record.exchange)
      .filter(Boolean);
    // Only successful resolutions are cached, so a transient failure can never
    // poison a domain for the next hour.
    mxCache.set(key, { records, at: Date.now() });
    return { records, failed: false };
  } catch (error) {
    const code = (error as { code?: string })?.code ?? "";
    if (DEFINITIVE_NO_MX.has(code)) {
      // Domain genuinely resolves with no mail exchanger — a real no-MX.
      mxCache.set(key, { records: [], at: Date.now() });
      return { records: [], failed: false };
    }
    // Timeout / SERVFAIL / REFUSED / network — do not treat as no-MX.
    return { records: [], failed: true };
  }
}

/** Back-compat helper: just the records (empty on any failure). */
export async function resolveMxRecords(domain: string): Promise<string[]> {
  return (await lookupMx(domain)).records;
}

/** Everything the verdict logic needs, gathered by the checks below. */
export interface Signals {
  email: string;
  username: string;
  domain: string;
  validSyntax: boolean;
  disposable: boolean;
  role: boolean;
  free: boolean;
  mxRecords: string[];
  /** The MX lookup failed transiently (not a genuine no-MX). */
  mxLookupFailed: boolean;
  gibberish: boolean;
  trapDomain: boolean;
  didYouMean: string | null;
  /** null = SMTP step did not run (quick mode, or port blocked). */
  smtp: SmtpProbeResult | null;
}

/**
 * The pure decision: signals in, verdict out. Kept separate from the I/O so the
 * status/score rules are covered by the smoke tests.
 */
export function deriveVerdict(signals: Signals): {
  status: ValidationStatus;
  score: number;
  deliverable: boolean | null;
  detail: string;
} {
  if (!signals.validSyntax) {
    return { status: "invalid_syntax", score: 0, deliverable: false, detail: "Failed RFC syntax check." };
  }
  if (signals.trapDomain) {
    return { status: "spamtrap", score: 0, deliverable: false, detail: "Domain is a known spam trap / honeypot." };
  }
  if (signals.disposable) {
    return { status: "disposable", score: 0, deliverable: false, detail: "Disposable / temporary email provider." };
  }
  if (signals.mxRecords.length === 0) {
    if (signals.mxLookupFailed) {
      // The lookup broke (timeout / SERVFAIL / network), which is NOT the same
      // as the domain having no MX. Hold as unknown and retry — never delete.
      return {
        status: "unknown",
        score: 40,
        deliverable: null,
        detail: "Could not resolve MX right now (temporary DNS issue) — will retry.",
      };
    }
    const meant = signals.didYouMean ? ` Did you mean ${signals.username}@${signals.didYouMean}?` : "";
    return { status: "no_mx", score: 0, deliverable: false, detail: `Domain has no MX records — it cannot receive mail.${meant}` };
  }

  // From here the domain can receive mail. If we ran an SMTP probe, use it.
  const smtp = signals.smtp;
  if (smtp && smtp.connected) {
    if (smtp.disabled) {
      return { status: "disabled", score: 5, deliverable: false, detail: "Mailbox is disabled or suspended by the provider." };
    }
    if (smtp.inboxFull) {
      return { status: "inbox_full", score: 30, deliverable: false, detail: "Mailbox exists but is full." };
    }
    if (smtp.catchAll) {
      // Catch-all: won't hard-bounce, but the individual inbox is unconfirmed.
      return { status: "catch_all", score: 70, deliverable: true, detail: "Domain accepts all addresses (catch-all)." };
    }
    if (smtp.rejected) {
      return { status: "invalid", score: 0, deliverable: false, detail: `Mailbox does not exist (${smtp.code ?? "5xx"}).` };
    }
    if (smtp.accepted) {
      const score = signals.role ? 92 : signals.gibberish ? 80 : 98;
      return { status: signals.role ? "role_account" : "safe", score, deliverable: true, detail: "Mailbox exists and accepts mail." };
    }
    // Connected but no clear verdict — fall through to the quick result.
  }

  // Quick verdict (no SMTP, or SMTP was indeterminate/blocked). MX is good and
  // syntax is clean, so it is sendable; we just cannot confirm the mailbox.
  if (signals.gibberish) {
    // Suspicious local part on a real domain: keep it out of campaigns until a
    // power check can confirm it, but do not delete it — it might be real.
    return { status: "unknown", score: 45, deliverable: null, detail: "Domain is fine, but the address looks randomly generated — needs a deep (power) check." };
  }
  const score = signals.role ? 80 : signals.free ? 82 : 85;
  return {
    status: signals.role ? "role_account" : "valid",
    score,
    deliverable: null,
    detail: "Syntax, domain and MX are valid. Run a power check to confirm the mailbox exists.",
  };
}

function toResult(signals: Signals, mode: VerificationMode): VerificationResult {
  const verdict = deriveVerdict(signals);
  const smtp = signals.smtp;
  return {
    email: signals.email,
    username: signals.username,
    domain: signals.domain,
    status: verdict.status,
    overallScore: verdict.score,
    isSafeToSend: isSendableStatus(verdict.status),
    isValidSyntax: signals.validSyntax,
    isDisposable: signals.disposable,
    isRoleAccount: signals.role,
    isFreeEmail: signals.free,
    mxAcceptsMail: signals.mxRecords.length > 0,
    mxRecords: signals.mxRecords,
    mxLookupFailed: signals.mxLookupFailed,
    canConnectSmtp: smtp ? smtp.connected : null,
    isCatchAll: smtp && smtp.connected ? smtp.catchAll : null,
    hasInboxFull: smtp && smtp.connected ? smtp.inboxFull : null,
    isDisabled: smtp && smtp.connected ? smtp.disabled : null,
    isDeliverable: verdict.deliverable,
    isSpamtrap: signals.trapDomain,
    didYouMean: signals.didYouMean,
    mode,
    checkedAt: new Date().toISOString(),
    detail: verdict.detail,
  };
}

export interface VerifyOptions {
  mode?: VerificationMode;
  /** Real deliverable envelope sender for the SMTP probe (a sending mailbox). */
  mailFrom?: string;
  smtpTimeoutMs?: number;
}

/** Verifies a single address. */
export async function verifyEmail(
  rawEmail: string,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const mode = options.mode ?? "quick";
  const email = normalizeEmail(rawEmail);
  const at = email.lastIndexOf("@");
  const username = at === -1 ? email : email.slice(0, at);
  const domain = emailDomain(email);

  const validSyntax = Boolean(email) && validator.isEmail(email);

  const base: Signals = {
    email,
    username,
    domain,
    validSyntax,
    disposable: false,
    role: false,
    free: false,
    mxRecords: [],
    mxLookupFailed: false,
    gibberish: false,
    trapDomain: false,
    didYouMean: null,
    smtp: null,
  };

  if (!validSyntax) return toResult(base, mode);

  base.disposable = isDisposableDomainName(domain);
  base.role = isRoleAccount(email);
  base.free = isFreeEmailDomain(domain);
  base.gibberish = isGibberishLocalPart(username);
  base.trapDomain = isKnownTrapDomain(domain);
  base.didYouMean = suggestDomain(domain);

  // Short-circuit before the network for the cases that need no MX lookup.
  if (base.trapDomain || base.disposable) return toResult(base, mode);

  const mx = await lookupMx(domain);
  base.mxRecords = mx.records;
  base.mxLookupFailed = mx.failed;
  if (base.mxRecords.length === 0) return toResult(base, mode);

  if (mode === "power" && options.mailFrom) {
    // Try MX hosts in priority order until one gives a usable answer.
    for (const mxHost of base.mxRecords.slice(0, 2)) {
      const probe = await probeMailbox(email, {
        mxHost,
        mailFrom: options.mailFrom,
        timeoutMs: options.smtpTimeoutMs,
      });
      base.smtp = probe;
      // A connected conversation with a real verdict is enough; a blocked/timed
      // out attempt on the first host is worth retrying on the next.
      if (probe.connected) break;
    }
  }

  return toResult(base, mode);
}

/** Verifies many addresses with bounded concurrency. */
export async function verifyMany(
  emails: string[],
  options: VerifyOptions & { concurrency?: number } = {},
): Promise<VerificationResult[]> {
  const concurrency = options.concurrency ?? (options.mode === "power" ? 3 : 8);
  const results: VerificationResult[] = [];
  for (let i = 0; i < emails.length; i += concurrency) {
    const slice = emails.slice(i, i + concurrency);
    results.push(...(await Promise.all(slice.map((email) => verifyEmail(email, options)))));
  }
  return results;
}
