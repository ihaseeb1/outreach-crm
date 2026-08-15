/**
 * Warmup planning maths. Pure functions — the ramp and peer-selection rules are
 * the parts most worth pinning down in tests, since getting them wrong means
 * either a volume spike (which providers punish) or a warmup that never grows.
 */

export interface RampInput {
  current: number;
  target: number;
  increment: number;
}

/** One step of the ramp, never overshooting the target. */
export function nextVolume({ current, target, increment }: RampInput): number {
  if (current >= target) return target;
  return Math.min(target, current + Math.max(0, increment));
}

/** The ramp advances at most once per calendar day. */
export function shouldRampToday(
  lastRampedOn: string | null,
  today: string,
): boolean {
  return lastRampedOn !== today;
}

/**
 * A mailbox that has been paused for poor health must not resume at the volume
 * it reached before — that is exactly the spike providers look for. Coming back
 * restarts from a small floor.
 */
export function resumeVolume(current: number, floor = 5): number {
  return Math.min(current, floor);
}

export function quotaRemaining(dailyVolume: number, sentToday: number): number {
  return Math.max(0, dailyVolume - sentToday);
}

export interface PeerCandidate {
  id: string;
  email: string;
  /** When this mailbox last received warmup mail; nulls sort first. */
  lastReceivedAt: string | null;
}

/**
 * Picks who to warm up with: the peer that has gone longest without receiving
 * anything, chosen from the least-recently-used half of the pool so the pattern
 * is not perfectly predictable.
 */
export function pickPeer(
  pool: PeerCandidate[],
  excludeId: string,
  random: () => number = Math.random,
): PeerCandidate | null {
  const candidates = pool.filter((peer) => peer.id !== excludeId);
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const aTime = a.lastReceivedAt ? Date.parse(a.lastReceivedAt) : 0;
    const bTime = b.lastReceivedAt ? Date.parse(b.lastReceivedAt) : 0;
    return aTime - bTime;
  });

  const half = Math.max(1, Math.ceil(sorted.length / 2));
  return sorted[Math.floor(random() * half)] ?? sorted[0] ?? null;
}

/** Whether a received warmup message should be replied to. */
export function shouldReply(replyRate: number, random: () => number = Math.random): boolean {
  return random() < Math.min(1, Math.max(0, replyRate));
}

/**
 * Warmup needs at least two mailboxes to form a loop. More is better — a larger
 * pool means less repetition between the same pair, which reads more naturally.
 */
export const MIN_POOL_SIZE = 2;

export function poolIsViable(size: number): boolean {
  return size >= MIN_POOL_SIZE;
}
