/**
 * Warmup auto-deletion — the pure core. No I/O, so it is fully smoke-tested.
 *
 * THE ONE SAFETY RULE, used identically in every place that touches warmup
 * (runtime tagging cross-check, the backfill, the DB purge, and the mailbox
 * purge): an email is warmup ONLY when BOTH the sender AND every recipient is
 * one of your own connected mailboxes — the warmup pool. If EITHER side is an
 * external address (a real publisher or webmaster), it is NOT warmup and must
 * never be deleted.
 *
 * Nothing here looks at subject text, domains, or "looks automated". The
 * external-counterparty test is the whole guarantee that no outreach email is
 * ever deleted. Every check fails safe: missing data, an unparseable date, or a
 * single external recipient all resolve to "do not delete".
 */

export type PoolSet = Set<string>;

export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Builds the pool of "my accounts" from connected-mailbox email addresses. */
export function buildPool(emails: Iterable<string | null | undefined>): PoolSet {
  const pool = new Set<string>();
  for (const email of emails) {
    const normalized = normalizeEmail(email);
    if (normalized) pool.add(normalized);
  }
  return pool;
}

export interface Party {
  fromEmail: string | null | undefined;
  /** to + cc + bcc, however many. */
  recipients: (string | null | undefined)[];
}

/**
 * The ground truth. True only when the sender is in the pool AND there is at
 * least one recipient AND every recipient is in the pool. A single external
 * recipient — cc or bcc included — makes it not-warmup.
 */
export function isWarmupByPool(party: Party, pool: PoolSet): boolean {
  const from = normalizeEmail(party.fromEmail);
  if (!from || !pool.has(from)) return false;

  const recipients = party.recipients.map(normalizeEmail).filter(Boolean);
  if (recipients.length === 0) return false;

  return recipients.every((recipient) => pool.has(recipient));
}

/** Splits a header-style address list ("a@x, b@y; c@z") into addresses. */
export function splitAddresses(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.includes("@"));
}

/** The columns of a `messages` row this needs — nothing else is read. */
export interface MessageLike {
  from_email: string | null;
  to_email: string | null;
  /** Warmup never carries cc/bcc, but if a row ever does, read it defensively. */
  meta?: Record<string, unknown> | null;
}

/**
 * Every recipient of a message: `to_email`, plus any cc/bcc found in `meta`.
 *
 * The schema has only a single `to_email` column, so in practice this is one
 * address — but the rule is "if ANY recipient is external it is not warmup", so
 * the extraction has to surface every recipient a row could carry rather than
 * assume there is only one.
 */
export function recipientsOf(row: MessageLike): string[] {
  const out: string[] = [];
  if (row.to_email) out.push(row.to_email);

  const meta = (row.meta ?? {}) as Record<string, unknown>;
  for (const key of ["cc", "bcc", "to"]) {
    const value = meta[key];
    if (typeof value === "string") out.push(...splitAddresses(value));
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") out.push(item);
    }
  }
  return out;
}

/** Whether a `messages` row is warmup by the pool-membership rule. */
export function messageIsWarmup(row: MessageLike, pool: PoolSet): boolean {
  return isWarmupByPool(
    { fromEmail: row.from_email, recipients: recipientsOf(row) },
    pool,
  );
}

// ---------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------

export type RetentionRule = "today" | "7d" | "14d";

export const DEFAULT_RETENTION: RetentionRule = "7d";

export const RETENTION_RULES: {
  rule: RetentionRule;
  label: string;
  description: string;
}[] = [
  { rule: "today", label: "Today", description: "Delete at the end of the same day" },
  { rule: "7d", label: "7 days", description: "Delete when older than 7 days" },
  { rule: "14d", label: "2 weeks", description: "Delete when older than 14 days" },
];

/** Normalises a stored/typed retention value, defaulting to 7 days. */
export function parseRetention(value: unknown): RetentionRule {
  if (value === "today" || value === "7d" || value === "14d") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase().replace(/\s+/g, "");
    if (v === "today" || v === "sameday" || v === "same_day" || v === "endofday") {
      return "today";
    }
    if (v === "7days" || v === "7day" || v === "week" || v === "1week") return "7d";
    if (
      v === "14days" || v === "14day" || v === "2weeks" ||
      v === "2week" || v === "fortnight"
    ) {
      return "14d";
    }
  }
  return DEFAULT_RETENTION;
}

/** Effective rule: per-mailbox override, else workspace default, else 7d. */
export function resolveRetention(
  mailboxValue: unknown,
  workspaceValue: unknown,
): RetentionRule {
  if (
    mailboxValue === "today" || mailboxValue === "7d" || mailboxValue === "14d"
  ) {
    return mailboxValue;
  }
  return parseRetention(workspaceValue);
}

const DAY_MS = 86_400_000;

/**
 * Anything sent strictly BEFORE this instant is past retention.
 *
 *  - "today": the start of the current UTC day, so a warmup sent on any earlier
 *    UTC day is expired — i.e. it is deleted at the end of the day it was sent.
 *    (The UTC boundary matches `sent_today_date`, which the whole app writes as
 *    toISOString().slice(0,10), so this can never disagree with the daily
 *    counter about which day a send belongs to.)
 *  - "7d" / "14d": now minus 7 / 14 days.
 */
export function retentionCutoff(rule: RetentionRule, now: Date = new Date()): Date {
  if (rule === "today") {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  const days = rule === "7d" ? 7 : 14;
  return new Date(now.getTime() - days * DAY_MS);
}

/** True when a send is old enough to expire. A missing/bad date never expires. */
export function isPastRetention(
  sentAt: string | null | undefined,
  rule: RetentionRule,
  now: Date = new Date(),
): boolean {
  if (!sentAt) return false;
  const at = Date.parse(sentAt);
  if (Number.isNaN(at)) return false;
  return at < retentionCutoff(rule, now).getTime();
}

export interface DeleteCandidate extends MessageLike {
  sent_at: string | null;
}

export type SkipReason =
  | "external_counterparty"
  | "within_retention"
  | "no_timestamp";

export interface DeleteDecision {
  delete: boolean;
  reason: "warmup_past_retention" | SkipReason;
}

/**
 * The single decision every delete path runs, so the DB pass and the mailbox
 * pass can never disagree about what is safe to remove. Re-checks pool
 * membership every time — the `is_warmup` flag is a fast pre-filter, never
 * trusted on its own at the moment of deletion.
 */
export function shouldDeleteMessage(
  row: DeleteCandidate,
  pool: PoolSet,
  rule: RetentionRule,
  now: Date = new Date(),
): DeleteDecision {
  if (!messageIsWarmup(row, pool)) {
    return { delete: false, reason: "external_counterparty" };
  }
  if (!row.sent_at) {
    return { delete: false, reason: "no_timestamp" };
  }
  if (!isPastRetention(row.sent_at, rule, now)) {
    return { delete: false, reason: "within_retention" };
  }
  return { delete: true, reason: "warmup_past_retention" };
}

// ---------------------------------------------------------------------
// Batch safety
// ---------------------------------------------------------------------

/**
 * The most rows one purge batch may touch. A run that matches more than this is
 * treated as an anomaly (a bad pool, a clock jump, a query gone wrong) and is
 * ABORTED and logged instead of deleting — better to under-delete and be asked
 * again next tick than to delete a surprising amount in one go.
 */
export const MAX_DELETE_BATCH = 500;

export function batchIsSane(count: number, max = MAX_DELETE_BATCH): boolean {
  return Number.isFinite(count) && count >= 0 && count <= max;
}

/**
 * The abort tripwire.
 *
 * A large *legitimate* backlog is not dangerous — every row was individually
 * confirmed warmup by the pool rule — so the purge drains it in bounded batches
 * rather than deleting it all at once, and never gets stuck. What IS dangerous
 * is the `is_warmup` flag disagreeing with the live pool at scale: that means
 * the flag has been set on things that are not warmup, and the whole run should
 * stop rather than trust it. More than this many flag-vs-pool disagreements in
 * one pass aborts the pass without deleting anything.
 */
export const ANOMALY_ABORT_THRESHOLD = 10;

/**
 * How long a soft-deleted row waits before it is hard-deleted from the database.
 * The mailbox copy, by contrast, is only ever moved to Trash, where the provider
 * keeps it recoverable for ~30 days on its own.
 */
export const HARD_DELETE_GRACE_DAYS = 7;

export function isPastGrace(
  deletedAt: string | null | undefined,
  graceDays = HARD_DELETE_GRACE_DAYS,
  now: Date = new Date(),
): boolean {
  if (!deletedAt) return false;
  const at = Date.parse(deletedAt);
  if (Number.isNaN(at)) return false;
  return at < now.getTime() - graceDays * DAY_MS;
}

// ---------------------------------------------------------------------
// Workspace setting shape
// ---------------------------------------------------------------------

export interface WarmupDeletionSettings {
  /** Master switch. Deletion is OFF until this is explicitly turned on. */
  autoDeleteEnabled: boolean;
  /** Workspace-wide default retention, overridable per mailbox. */
  deleteAfter: RetentionRule;
}

/** Reads the warmup-deletion settings out of a workspace `settings` jsonb. */
export function readDeletionSettings(
  settings: Record<string, unknown> | null | undefined,
): WarmupDeletionSettings {
  const warmup =
    settings && typeof settings === "object"
      ? ((settings as Record<string, unknown>).warmup as
          | Record<string, unknown>
          | undefined)
      : undefined;

  return {
    autoDeleteEnabled: warmup?.auto_delete_enabled === true,
    deleteAfter: parseRetention(warmup?.delete_after),
  };
}
