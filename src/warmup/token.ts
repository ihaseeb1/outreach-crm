import crypto from "node:crypto";

import { env } from "@/lib/env";

/**
 * Signed marker carried in the `X-OCRM-Warmup` header of every warmup email.
 *
 * This is what keeps warmup traffic out of the unified inbox. It is signed
 * rather than a fixed string so nobody outside the workspace can forge a header
 * that makes their mail invisible to you.
 */

export function warmupToken(workspaceId: string, nonce: string): string {
  const signature = crypto
    .createHmac("sha256", env.encryptionKey())
    .update(`warmup:${workspaceId}:${nonce}`)
    .digest("base64url")
    .slice(0, 32);
  return `${nonce}.${signature}`;
}

export function newWarmupToken(workspaceId: string): string {
  return warmupToken(workspaceId, crypto.randomBytes(9).toString("base64url"));
}

export function isValidWarmupToken(workspaceId: string, token: string): boolean {
  const [nonce, signature] = token.split(".");
  if (!nonce || !signature) return false;

  const expected = warmupToken(workspaceId, nonce).split(".")[1] ?? "";
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
