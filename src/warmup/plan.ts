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

export interface WarmupState {
  enabled: boolean;
  currentDailyVolume: number;
  targetDailyVolume: number;
}

/**
 * How many campaign emails a mailbox may actually send today.
 *
 * Warmup ramping its own peer volume is only half the job. Without this, a
 * mailbox three days into a 40-day ramp would still send whatever
 * `daily_limit` said — which is the volume spike warmup exists to avoid. While
 * the ramp is climbing, real sending is held to the volume already reached.
 *
 * A mailbox with warmup switched off keeps its configured limit untouched:
 * turning warmup off is an explicit choice, and silently overriding the limit
 * would be worse than honouring it.
 */
export function sendingAllowance(
  dailyLimit: number,
  warmup: WarmupState | null,
): number {
  if (!warmup || !warmup.enabled) return dailyLimit;

  const warmed = Math.max(0, warmup.currentDailyVolume);
  const stillRamping = warmed < warmup.targetDailyVolume;

  return stillRamping ? Math.min(dailyLimit, warmed) : dailyLimit;
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
/**
 * Multi-turn warmup threads.
 *
 * A mailbox whose entire history is isolated one-reply exchanges does not look
 * like a mailbox anyone uses. Real correspondence has some back-and-forth. But
 * doing it on every thread is its own tell, and it burns daily volume fast —
 * every extra turn is another send against the same cap.
 *
 * So roughly one thread in two becomes a conversation of two to four replies;
 * the rest stay single-reply. The choice is derived from the root message id
 * rather than a coin flip, so a thread's fate is stable no matter how many
 * ticks it takes to play out — a random draw per tick would make the same
 * thread continue or stop depending on when it was looked at.
 *
 * This was one in four, with conversations of two or three replies. Half the
 * threads and up to four replies is a deliberate move towards a mailbox whose
 * history looks like it belongs to somebody: an account whose entire record is
 * send-and-single-reply is the pattern a provider can spot without reading a
 * word. It costs volume rather than adding it — every extra turn is another
 * send against the same daily cap — so it trades new threads for deeper ones,
 * which is the right way round.
 */
export const CONVERSATION_IN_EVERY = 2;

function hashOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function isConversationThread(
  rootMessageId: string | null,
  everyN: number = CONVERSATION_IN_EVERY,
): boolean {
  if (!rootMessageId || everyN <= 1) return Boolean(rootMessageId);
  return hashOf(rootMessageId) % everyN === 0;
}

/**
 * Total messages a conversation thread should reach, counting the original.
 * Three or four — that is two or three replies on top.
 *
 * Bounded by how much is actually written, not by taste: each topic in the
 * corpus supplies three turns of replies, each answering the turn above it. A
 * longer thread would have to reuse a turn, and two messages from the same
 * small pool in one conversation is how a thread ends up half-repeating itself
 * — worse than a thread that simply ends.
 */
export function conversationLength(rootMessageId: string): number {
  return 3 + (hashOf(rootMessageId) % 2);
}

/**
 * Whether a received warmup message should be replied to, given where it sits
 * in its thread. `depth` is how many messages already exist in the thread.
 *
 * Depth 1 — the original — is always eligible; that is the ordinary single
 * reply, still subject to reply_rate. Beyond that, only conversation threads
 * continue, and only until they reach their target length.
 */
export function shouldContinueThread(
  depth: number,
  rootMessageId: string | null,
  everyN: number = CONVERSATION_IN_EVERY,
): boolean {
  if (depth < 1) return false;
  if (depth === 1) return true;
  if (!rootMessageId || !isConversationThread(rootMessageId, everyN)) return false;
  return depth < conversationLength(rootMessageId);
}

export const MIN_POOL_SIZE = 2;

export function poolIsViable(size: number): boolean {
  return size >= MIN_POOL_SIZE;
}
