import {
  isSendableStatus as engineIsSendable,
  resolveMxRecords,
  verifyEmail as engineVerify,
  verifyMany as engineVerifyMany,
  type VerificationMode,
  type VerificationResult,
} from "@/validation/verify-engine";
import type { ValidationStatus } from "@/types/db";

/**
 * Thin compatibility layer over the verification engine.
 *
 * The real work now lives in `verify-engine.ts` (the Reoon-style verifier:
 * syntax, disposable, MX, role, free-provider, typo, gibberish and — in power
 * mode — a real SMTP mailbox-existence + catch-all check). This file keeps the
 * older `validateEmail`/`isSendableStatus`/`validateMany` surface that the rest
 * of the app imports, so nothing else had to change name.
 */

export interface ValidationResult {
  email: string;
  status: ValidationStatus;
  mxHost: string | null;
  isRole: boolean;
  checkedAt: string;
  detail?: string;
  /** Full engine result, for callers that want the Reoon-style detail. */
  verification: VerificationResult;
}

export async function resolveMxHost(domain: string): Promise<string | null> {
  const records = await resolveMxRecords(domain);
  return records[0] ?? null;
}

function toLegacy(result: VerificationResult): ValidationResult {
  return {
    email: result.email,
    status: result.status,
    mxHost: result.mxRecords[0] ?? null,
    isRole: result.isRoleAccount,
    checkedAt: result.checkedAt,
    detail: result.detail,
    verification: result,
  };
}

export async function validateEmail(
  rawEmail: string,
  options: { mode?: VerificationMode; mailFrom?: string } = {},
): Promise<ValidationResult> {
  return toLegacy(await engineVerify(rawEmail, options));
}

/** Statuses that are safe to send to (still subject to canSend()). */
export function isSendableStatus(status: ValidationStatus): boolean {
  return engineIsSendable(status);
}

export async function validateMany(
  emails: string[],
): Promise<ValidationResult[]> {
  const results = await engineVerifyMany(emails, { mode: "quick" });
  return results.map(toLegacy);
}
