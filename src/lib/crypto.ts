import crypto from "node:crypto";

import { env } from "@/lib/env";

/**
 * AES-256-GCM at-rest encryption for mailbox credentials.
 * Ciphertext format: v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 *
 * Plaintext credentials must never be logged or returned to the client.
 */

const VERSION = "v1";

function key(): Buffer {
  const raw = env.encryptionKey();
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or 44 base64 chars).",
    );
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted payload.");
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypt an arbitrary credential object (SMTP/IMAP settings, OAuth tokens). */
export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}

/** Constant-time string compare for secrets (cron tokens, API keys). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** URL-safe random token (unsubscribe links, API keys). */
export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
