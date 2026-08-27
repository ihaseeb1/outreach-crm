import {
  isWithinSendWindow,
  type ResolvedWindow,
} from "@/campaigns/schedule";

/**
 * The "why isn't this contact sending?" engine (spec §4.1).
 *
 * A pure function so the reasons are covered by the smoke tests and can never
 * disagree with the send guard: for any enrolled contact that is not going out,
 * it returns a single human-readable reason, or null when the contact is either
 * resolved (replied/completed/...) or genuinely due to send on the next tick.
 *
 * The checks run most-fundamental first, so the reason shown is the *first*
 * thing that has to change — fixing it may reveal the next, exactly as the send
 * path would hit them in order.
 */

const TERMINAL = new Set(["replied", "completed", "unsubscribed", "bounced"]);

const BAD_VALIDATION = new Set([
  "invalid",
  "no_mx",
  "invalid_syntax",
  "disposable",
  "spamtrap",
  "disabled",
]);

export interface BlockerInput {
  /** campaign_contacts.status */
  status: string;
  currentStep: number;
  nextSendAt: string | null;
  lastError: string | null;
  pausedReason: string | null;
  /** contacts.validation_status */
  validationStatus: string | null;
  suppressed: boolean;
  /** campaigns.status */
  campaignStatus: string;
  /** A sequence step numbered currentStep+1 exists. */
  hasSequenceStep: boolean;
  /** At least one active, non-paused mailbox can serve this campaign. */
  hasActiveMailbox: boolean;
  now: Date;
  window: ResolvedWindow;
}

export interface Blocker {
  code: string;
  reason: string;
}

export function blockerReason(input: BlockerInput): Blocker | null {
  const { status } = input;

  // Resolved — not stuck, just finished. The status badge already says so.
  if (TERMINAL.has(status)) return null;

  if (status === "failed") {
    return {
      code: "failed",
      reason: input.lastError
        ? `Send failed: ${input.lastError}`
        : "Send failed after repeated attempts. Requeue to retry.",
    };
  }

  if (status === "paused") {
    return {
      code: "paused",
      reason: input.pausedReason
        ? `Paused: ${input.pausedReason}`
        : "Enrolment is paused.",
    };
  }

  // pending / active — work out why it is not leaving right now.

  if (input.suppressed) {
    return {
      code: "suppressed",
      reason: "Address is on the suppression list — it will never be emailed.",
    };
  }

  if (input.validationStatus && BAD_VALIDATION.has(input.validationStatus)) {
    return {
      code: "invalid_address",
      reason: `Address failed verification (${input.validationStatus}).`,
    };
  }

  if (input.campaignStatus !== "active") {
    return {
      code: "campaign_inactive",
      reason: `Campaign is ${input.campaignStatus} — start it to send.`,
    };
  }

  if (!input.hasSequenceStep) {
    return {
      code: "no_step",
      reason: `No step ${input.currentStep + 1} defined in the sequence.`,
    };
  }

  if (!input.hasActiveMailbox) {
    return {
      code: "no_mailbox",
      reason: "No active mailbox assigned — connect one or clear its pause.",
    };
  }

  const due = input.nextSendAt ? new Date(input.nextSendAt) : null;
  if (due && due.getTime() > input.now.getTime()) {
    return {
      code: "scheduled",
      reason: "Scheduled — waiting for the next step to fall due.",
    };
  }

  if (!isWithinSendWindow(input.now, input.window)) {
    return {
      code: "outside_window",
      reason: "Outside the sending window — will send when it next opens.",
    };
  }

  // Due, in window, address fine, mailbox available: it goes on the next tick.
  return null;
}
