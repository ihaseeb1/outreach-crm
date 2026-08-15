/**
 * Reputation scoring. Pure — no I/O — so every threshold is covered by tests.
 *
 * Everything here comes from free signals: your own bounce and complaint rates,
 * whether warmup mail is landing in spam, DNS auth records, and public DNSBLs.
 */

export type HealthStatus = "healthy" | "warning" | "paused";

export interface HealthSignals {
  /** Campaign emails sent in the last 7 days — the denominator for the rates. */
  sent7d: number;
  bounceRate: number;
  complaintRate: number;
  /** Fraction of recent warmup mail that had to be rescued from spam. */
  warmupSpamRate: number;
  spfOk: boolean | null;
  dkimOk: boolean | null;
  dmarcOk: boolean | null;
  blacklists: string[];
}

export interface HealthVerdict {
  score: number;
  status: HealthStatus;
  issues: string[];
}

/**
 * Below this, the rates are too noisy to act on: one bounce out of three sends
 * is 33%, which would pause a perfectly healthy new mailbox.
 */
export const MIN_VOLUME_FOR_RATES = 20;

export const THRESHOLDS = {
  bouncePause: 0.08,
  bounceWarn: 0.04,
  complaintPause: 0.003,
  complaintWarn: 0.001,
  warmupSpamPause: 0.6,
  warmupSpamWarn: 0.25,
} as const;

export function scoreMailbox(signals: HealthSignals): HealthVerdict {
  const issues: string[] = [];
  let score = 100;
  let status: HealthStatus = "healthy";

  const escalate = (next: HealthStatus) => {
    const rank = { healthy: 0, warning: 1, paused: 2 } as const;
    if (rank[next] > rank[status]) status = next;
  };

  const enoughVolume = signals.sent7d >= MIN_VOLUME_FOR_RATES;

  // --- Bounces ---
  if (signals.bounceRate >= THRESHOLDS.bouncePause) {
    score -= 40;
    issues.push(
      `Bounce rate ${pct(signals.bounceRate)} over the last 7 days — clean the list before sending more.`,
    );
    escalate(enoughVolume ? "paused" : "warning");
  } else if (signals.bounceRate >= THRESHOLDS.bounceWarn) {
    score -= 20;
    issues.push(`Bounce rate ${pct(signals.bounceRate)} is above a safe level.`);
    escalate("warning");
  } else if (signals.bounceRate > 0.02) {
    score -= 8;
  }

  // --- Complaints ---
  if (signals.complaintRate >= THRESHOLDS.complaintPause) {
    score -= 35;
    issues.push(`Complaint rate ${pct(signals.complaintRate)} — recipients are marking this as spam.`);
    escalate(enoughVolume ? "paused" : "warning");
  } else if (signals.complaintRate >= THRESHOLDS.complaintWarn) {
    score -= 15;
    issues.push(`Complaint rate ${pct(signals.complaintRate)} is creeping up.`);
    escalate("warning");
  }

  // --- Warmup landing in spam: the earliest free warning available ---
  if (signals.warmupSpamRate >= THRESHOLDS.warmupSpamPause) {
    score -= 30;
    issues.push(
      `${pct(signals.warmupSpamRate)} of warmup mail landed in spam — reputation is poor.`,
    );
    escalate("paused");
  } else if (signals.warmupSpamRate >= THRESHOLDS.warmupSpamWarn) {
    score -= 15;
    issues.push(`${pct(signals.warmupSpamRate)} of warmup mail landed in spam.`);
    escalate("warning");
  }

  // --- Blacklists ---
  if (signals.blacklists.length > 0) {
    score -= 40;
    issues.push(`Domain is listed on: ${signals.blacklists.join(", ")}.`);
    escalate("paused");
  }

  // --- DNS authentication. Config faults, not reputation collapse, so these
  //     warn rather than pause — pausing would not fix them. ---
  if (signals.spfOk === false) {
    score -= 12;
    issues.push("No SPF record on the sending domain.");
    escalate("warning");
  }
  if (signals.dkimOk === false) {
    score -= 12;
    issues.push("No DKIM key found for the sending domain.");
    escalate("warning");
  }
  if (signals.dmarcOk === false) {
    score -= 6;
    issues.push("No DMARC record on the sending domain.");
    escalate("warning");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status,
    issues,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}
