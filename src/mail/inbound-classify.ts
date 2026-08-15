/**
 * Classifies an inbound email before it is allowed anywhere near the inbox.
 *
 * The unified inbox must contain REAL replies from prospects only. Warmup
 * traffic between your own mailboxes, bounce notifications, and out-of-office
 * autoresponders are all detected here and routed elsewhere — they never become
 * a conversation.
 *
 * Pure function, no I/O, so it is fully covered by the smoke tests.
 */

export const WARMUP_HEADER = "x-ocrm-warmup";
export const CAMPAIGN_HEADER = "x-ocrm-campaign";

export type InboundKind = "reply" | "warmup" | "bounce" | "auto_reply";

export interface ClassifyInput {
  fromEmail: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  /**
   * Every mailbox connected to this workspace. Mail from one of your own
   * addresses is internal traffic, never a prospect reply.
   */
  ownMailboxes?: Set<string>;
}

export interface Classification {
  kind: InboundKind;
  bouncedRecipient: string | null;
  bounceType: "hard" | "soft" | null;
  reason: string;
}

const BOUNCE_SENDERS = [
  "mailer-daemon",
  "postmaster",
  "mail-delivery",
  "maildeliverysystem",
  "no-reply-delivery",
];

const BOUNCE_SUBJECTS = [
  "undelivered mail returned to sender",
  "delivery status notification (failure)",
  "delivery status notification (delay)",
  "returned mail",
  "mail delivery failed",
  "undeliverable",
  "failure notice",
  "delivery incomplete",
  "message not delivered",
  "address not found",
];

const AUTO_REPLY_SUBJECTS = [
  "out of office",
  "auto-reply",
  "autoreply",
  "automatic reply",
  "away from my desk",
  "on vacation",
  "abwesenheitsnotiz",
];

export function classifyInbound(input: ClassifyInput): Classification {
  const headers = input.headers;
  const from = input.fromEmail.toLowerCase();
  const subject = (input.subject ?? "").toLowerCase();

  // 1. Warmup traffic — tagged by us on the way out, so unmistakable on the
  //    way back in. Checked first: warmup replies would otherwise look like
  //    perfectly normal replies.
  if (headers[WARMUP_HEADER]) {
    return {
      kind: "warmup",
      bouncedRecipient: null,
      bounceType: null,
      reason: "Carries the warmup header.",
    };
  }

  // 2. Anything from one of your own connected mailboxes is internal.
  if (input.ownMailboxes?.has(from)) {
    return {
      kind: "warmup",
      bouncedRecipient: null,
      bounceType: null,
      reason: "Sent from one of your own connected mailboxes.",
    };
  }

  // 3. Bounces / delivery status notifications.
  const localPart = from.split("@")[0] ?? "";
  const contentType = headers["content-type"] ?? "";
  const looksLikeDsn =
    /report-type\s*=\s*"?delivery-status/i.test(contentType) ||
    BOUNCE_SENDERS.some((sender) => localPart.includes(sender)) ||
    BOUNCE_SUBJECTS.some((needle) => subject.includes(needle));

  if (looksLikeDsn) {
    const { recipient, type } = parseBounceBody(input.text);
    return {
      kind: "bounce",
      bouncedRecipient: recipient,
      bounceType: type,
      reason: "Delivery status notification.",
    };
  }

  // 4. Vacation responders and other automated mail. RFC 3834 first, then the
  //    older de-facto headers, then the subject line.
  const autoSubmitted = headers["auto-submitted"] ?? "";
  const precedence = (headers["precedence"] ?? "").toLowerCase();
  const isAuto =
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
    Boolean(headers["x-autoreply"]) ||
    Boolean(headers["x-autorespond"]) ||
    Boolean(headers["x-auto-response-suppress"]) ||
    ["auto_reply", "bulk", "junk"].includes(precedence) ||
    AUTO_REPLY_SUBJECTS.some((needle) => subject.includes(needle));

  if (isAuto) {
    return {
      kind: "auto_reply",
      bouncedRecipient: null,
      bounceType: null,
      reason: "Automated response.",
    };
  }

  return {
    kind: "reply",
    bouncedRecipient: null,
    bounceType: null,
    reason: "Genuine reply.",
  };
}

/**
 * Pulls the failed recipient and hardness out of a DSN body.
 * 5.x.x / 5xx = permanent (suppress). 4.x.x = temporary (retry later).
 */
export function parseBounceBody(body: string): {
  recipient: string | null;
  type: "hard" | "soft" | null;
} {
  const recipientMatch =
    /^(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>]+@[^\s<>]+)>?/im.exec(
      body,
    ) ?? /<([^\s<>]+@[^\s<>]+)>[^\n]*(?:does not exist|not found|unknown)/i.exec(body);

  const statusMatch = /^status:\s*([245])\.\d+\.\d+/im.exec(body);
  const smtpCodeMatch = /\b(5\d{2}|4\d{2})[\s-]/.exec(body);

  let type: "hard" | "soft" | null = null;
  if (statusMatch) {
    type = statusMatch[1] === "5" ? "hard" : "soft";
  } else if (smtpCodeMatch?.[1]?.startsWith("5")) {
    type = "hard";
  } else if (smtpCodeMatch?.[1]?.startsWith("4")) {
    type = "soft";
  }

  // Unambiguous permanent-failure wording, when no machine-readable part exists.
  if (
    !type &&
    /(user unknown|no such user|mailbox (?:does not exist|unavailable|not found)|address (?:rejected|not found)|recipient (?:rejected|not found)|does not exist)/i.test(
      body,
    )
  ) {
    type = "hard";
  }

  return { recipient: recipientMatch?.[1]?.toLowerCase() ?? null, type };
}
