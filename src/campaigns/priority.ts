/**
 * Send priority — which due contact goes first when quota is scarce.
 *
 * Spec §2: when a new campaign is launched while older campaigns still have
 * follow-ups due, the follow-ups must win the available quota. A big new
 * campaign must never starve either the follow-ups or the other campaigns.
 *
 * Pure functions so the ordering is covered by the smoke tests — getting it
 * wrong is invisible in a type check and only shows up as first-touch mail
 * going out while a week-old follow-up waits.
 */

export interface Prioritizable {
  id: string;
  campaign_id: string;
  /** 0 = never sent (next send is step 1); >=1 = mid-sequence (next is a follow-up). */
  current_step: number;
  next_send_at: string | null;
}

/**
 * The quota tier a due contact belongs to; a lower number sends first.
 *
 * `current_step` is how many steps have already gone out, so the email about
 * to send is step `current_step + 1`. A contact at step >= 1 is being followed
 * up (the next send is step >= 2) and outranks a first-touch (current_step 0,
 * next send is step 1).
 */
export function sendTier(currentStep: number): 1 | 2 {
  return currentStep >= 1 ? 1 : 2;
}

function dueTime(row: Prioritizable): number {
  // A missing next_send_at sorts oldest (0) — it is due now or overdue.
  return row.next_send_at ? Date.parse(row.next_send_at) : 0;
}

/**
 * Orders due contacts so follow-ups consume quota before new first-touch
 * sends, and so no single campaign starves the others within a tier.
 *
 * 1. Tier first: every follow-up (step >= 2) is placed ahead of every step-1.
 * 2. Within a tier, round-robin across campaigns. Each campaign's contacts are
 *    queued oldest-due first, then one is taken from each campaign in turn. A
 *    campaign that just enrolled 100 new contacts therefore cannot monopolise
 *    a tick — every campaign with work due gets a slot each pass.
 * 3. Campaigns lead each round in the order of their oldest waiting contact,
 *    so the campaign that has waited longest is served first.
 *
 * Stable and deterministic: no clock, no randomness. Ties (same tier, same
 * campaign, same due time) keep their input order.
 */
export function orderByPriority<T extends Prioritizable>(rows: T[]): T[] {
  const ordered: T[] = [];

  for (const tier of [1, 2] as const) {
    const inTier = rows.filter((row) => sendTier(row.current_step) === tier);
    if (inTier.length === 0) continue;

    // Group by campaign, each group oldest-due first.
    const byCampaign = new Map<string, T[]>();
    for (const row of inTier) {
      const list = byCampaign.get(row.campaign_id);
      if (list) list.push(row);
      else byCampaign.set(row.campaign_id, [row]);
    }
    for (const list of byCampaign.values()) {
      list.sort((a, b) => dueTime(a) - dueTime(b));
    }

    // Visit campaigns in the order of their oldest waiting contact. Each group
    // came from the Map above, so it is guaranteed non-empty — hence the `!`.
    let queues = [...byCampaign.values()].sort(
      (a, b) => dueTime(a[0]!) - dueTime(b[0]!),
    );

    // One contact from each campaign per round, until every queue is empty.
    while (queues.length > 0) {
      const next: T[][] = [];
      for (const queue of queues) {
        const item = queue.shift();
        if (item) ordered.push(item);
        if (queue.length > 0) next.push(queue);
      }
      queues = next;
    }
  }

  return ordered;
}
