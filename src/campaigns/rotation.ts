import { mailboxIsRested } from "@/campaigns/schedule";
import type { Mailbox } from "@/types/db";

/**
 * Mailbox rotation.
 *
 * Sends are spread across every eligible mailbox rather than hammering one.
 * A mailbox is eligible only if it is active, not health-paused, under its
 * daily limit, and has rested long enough since its last send.
 *
 * Pure functions so the smoke tests can cover the limit and rest rules.
 */

export type RotationMailbox = Pick<
  Mailbox,
  | "id"
  | "email"
  | "daily_limit"
  | "sent_today"
  | "sent_today_date"
  | "min_gap_seconds"
  | "max_gap_seconds"
  | "last_send_at"
  | "is_active"
  | "health_status"
>;

function sentToday(mailbox: RotationMailbox, now: Date): number {
  const today = now.toISOString().slice(0, 10);
  return mailbox.sent_today_date === today ? mailbox.sent_today : 0;
}

export function remainingCapacity(mailbox: RotationMailbox, now: Date): number {
  return Math.max(0, mailbox.daily_limit - sentToday(mailbox, now));
}

export interface EligibilityOptions {
  now?: Date;
  random?: () => number;
  /** Ignore the inter-send gap (used when only capacity matters, e.g. planning). */
  ignoreRest?: boolean;
  /**
   * When picking a mailbox for real outreach, prefer fully-healthy ones and use
   * `warning` (poor-health) mailboxes only as a last resort. Defaults to true;
   * set false when only raw capacity matters.
   */
  preferHealthy?: boolean;
}

export function isEligible(
  mailbox: RotationMailbox,
  options: EligibilityOptions = {},
): boolean {
  const now = options.now ?? new Date();

  if (!mailbox.is_active) return false;
  // Health status is set by the phase 4 job; a paused mailbox sends nothing,
  // campaign or warmup.
  if (mailbox.health_status === "paused") return false;
  if (remainingCapacity(mailbox, now) <= 0) return false;

  if (!options.ignoreRest) {
    // The mailbox's own inter-send gap is the pacing — never bypassed, so a
    // mailbox never fires two sends seconds apart. It sends at most once per
    // rest gap, which across the day's ticks is what fills its daily limit.
    return mailboxIsRested(
      mailbox.last_send_at,
      mailbox.min_gap_seconds,
      mailbox.max_gap_seconds,
      now,
      options.random,
    );
  }

  return true;
}

/**
 * Records a send against the in-memory pool.
 *
 * This is not bookkeeping, it is the thing that stops a batch emptying itself
 * down one mailbox. The pool is read from the database once per run, so without
 * writing the send back, `sent_today` and `last_send_at` stay frozen at their
 * starting values for the whole loop: the mailbox that just sent still looks
 * both fully rested and completely unused, so pickMailbox chooses it again, and
 * again. Five emails left one account back to back because of exactly this.
 *
 * Mutates in place, because the caller holds references into the same array
 * that rotation reads from.
 */
export function recordSend(mailbox: RotationMailbox, now: Date = new Date()): void {
  const today = now.toISOString().slice(0, 10);
  mailbox.sent_today = sentToday(mailbox, now) + 1;
  mailbox.sent_today_date = today;
  mailbox.last_send_at = now.toISOString();
}

export function eligibleMailboxes(
  mailboxes: RotationMailbox[],
  options: EligibilityOptions = {},
): RotationMailbox[] {
  return mailboxes.filter((mailbox) => isEligible(mailbox, options));
}

/** Most headroom today; ties broken by whoever has been idle longest. */
function bestOf(mailboxes: RotationMailbox[], now: Date): RotationMailbox | null {
  if (mailboxes.length === 0) return null;
  return mailboxes.reduce((best, candidate) => {
    const bestCapacity = remainingCapacity(best, now);
    const candidateCapacity = remainingCapacity(candidate, now);
    if (candidateCapacity !== bestCapacity) {
      return candidateCapacity > bestCapacity ? candidate : best;
    }
    const bestLast = best.last_send_at ? Date.parse(best.last_send_at) : 0;
    const candidateLast = candidate.last_send_at
      ? Date.parse(candidate.last_send_at)
      : 0;
    return candidateLast < bestLast ? candidate : best;
  });
}

/**
 * Picks the next mailbox to send real outreach from: the one with the most
 * headroom left today, breaking ties by whichever has been idle longest. That
 * keeps volume even across every connected mailbox instead of draining them in
 * order.
 *
 * Health-aware. A mailbox in `warning` — bouncing, drawing complaints, or with
 * warmup mail landing in spam — is poor-health, and pushing cold outreach
 * through it makes the reputation worse, not better. So outreach only ever
 * falls back to a `warning` mailbox when no fully-healthy one has capacity right
 * now; the rest of the time the poor-health accounts are left to the warmup
 * engine (which still runs on them) to recover. Set `preferHealthy: false` for
 * callers that only care about raw capacity, not what the send is for.
 */
export function pickMailbox(
  mailboxes: RotationMailbox[],
  options: EligibilityOptions = {},
): RotationMailbox | null {
  const now = options.now ?? new Date();
  const eligible = eligibleMailboxes(mailboxes, options);
  if (eligible.length === 0) return null;

  if (options.preferHealthy !== false) {
    const healthy = eligible.filter(
      (mailbox) => mailbox.health_status === "healthy",
    );
    if (healthy.length > 0) return bestOf(healthy, now);
  }

  return bestOf(eligible, now);
}

/**
 * Once a contact has been emailed from a mailbox, follow-ups stay on it so the
 * thread stays coherent.
 *
 * Two different reasons that mailbox might be unusable, handled differently:
 *
 * - It is in the pool but resting or at its daily cap. Transient — wait for it,
 *   because switching sender to save a few hours is not worth breaking the
 *   conversation.
 * - It is absent from the pool entirely: health-paused, deactivated or removed.
 *   Not transient. Waiting for it meant the contact was never followed up at
 *   all, silently, for as long as the mailbox stayed paused. Hand the step to a
 *   healthy mailbox instead and let the caller record the reassignment.
 *
 * The follow-up keeps the original subject and threading headers either way —
 * those come from the first message in the conversation, not from the sender.
 */
export function mailboxForContact(
  assignedId: string | null,
  mailboxes: RotationMailbox[],
  options: EligibilityOptions = {},
): { mailbox: RotationMailbox | null; waiting: boolean; switched: boolean } {
  if (assignedId) {
    const assigned = mailboxes.find((mailbox) => mailbox.id === assignedId);

    if (!assigned) {
      const replacement = pickMailbox(mailboxes, options);
      return {
        mailbox: replacement,
        waiting: replacement === null,
        switched: replacement !== null,
      };
    }

    if (isEligible(assigned, options)) {
      return { mailbox: assigned, waiting: false, switched: false };
    }
    return { mailbox: null, waiting: true, switched: false };
  }

  return {
    mailbox: pickMailbox(mailboxes, options),
    waiting: false,
    switched: false,
  };
}
