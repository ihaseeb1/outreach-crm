/**
 * One-click campaign cleanup (spec §8).
 *
 * A bulk cleanup may only ever remove enrolments that are already dead ends —
 * never a contact mid-sequence. Bounced and failed are always safe to clear;
 * the "finished" toggle additionally clears contacts that ran the whole
 * sequence with no reply (`completed`) or opted out (`unsubscribed`).
 *
 * Pure and shared: the button builds the status list here and the API validates
 * against the same set, so the two can never disagree about what is removable.
 */

export const CLEANABLE_STATUSES = [
  "bounced",
  "failed",
  "unsubscribed",
  "completed",
] as const;

export type CleanableStatus = (typeof CLEANABLE_STATUSES)[number];

export interface CleanupOptions {
  /** Also clear contacts that finished the sequence (completed) or opted out. */
  finished?: boolean;
}

/**
 * The exact status set a cleanup should purge. Bounced + failed always; the
 * `finished` toggle adds completed + unsubscribed. Order-stable so the request
 * and any log read the same.
 */
export function cleanupStatuses(opts: CleanupOptions = {}): CleanableStatus[] {
  const statuses: CleanableStatus[] = ["bounced", "failed"];
  if (opts.finished) statuses.push("completed", "unsubscribed");
  return statuses;
}

/** Guards the API: only a dead-end status may be bulk-removed. */
export function isCleanable(status: string): status is CleanableStatus {
  return (CLEANABLE_STATUSES as readonly string[]).includes(status);
}
