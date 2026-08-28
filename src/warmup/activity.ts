/**
 * "How many warmup emails, back and forth, per mailbox" — the number the
 * Deliverability page now shows so warmup stops being a black box.
 *
 * Counted by the `warmup_activity` function (migration 0013) so it is never
 * capped. If that function is not there yet, it falls back to reading the last
 * week of `warmup_messages` and tallying in JS, which is capped like any row
 * read but keeps the page working until the migration lands.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface WarmupActivity {
  sentToday: number;
  receivedToday: number;
  repliedToday: number;
  sent7d: number;
  received7d: number;
  replied7d: number;
  inSpam7d: number;
  rescued7d: number;
}

export function emptyActivity(): WarmupActivity {
  return {
    sentToday: 0,
    receivedToday: 0,
    repliedToday: 0,
    sent7d: 0,
    received7d: 0,
    replied7d: 0,
    inSpam7d: 0,
    rescued7d: 0,
  };
}

export interface WarmupActivityResult {
  byMailbox: Map<string, WarmupActivity>;
  totals: WarmupActivity;
}

export async function loadWarmupActivity(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<WarmupActivityResult> {
  const rpc = await supabase.rpc("warmup_activity", { p_workspace: workspaceId });
  if (!rpc.error && rpc.data) {
    return fromRpc(rpc.data as RpcRow[]);
  }
  return fromRows(supabase, workspaceId, now);
}

interface RpcRow {
  mailbox_id: string;
  sent_today: number;
  received_today: number;
  replied_today: number;
  sent_7d: number;
  received_7d: number;
  replied_7d: number;
  in_spam_7d: number;
  rescued_7d: number;
}

function fromRpc(rows: RpcRow[]): WarmupActivityResult {
  const byMailbox = new Map<string, WarmupActivity>();
  const totals = emptyActivity();

  for (const row of rows) {
    const activity: WarmupActivity = {
      sentToday: Number(row.sent_today),
      receivedToday: Number(row.received_today),
      repliedToday: Number(row.replied_today),
      sent7d: Number(row.sent_7d),
      received7d: Number(row.received_7d),
      replied7d: Number(row.replied_7d),
      inSpam7d: Number(row.in_spam_7d),
      rescued7d: Number(row.rescued_7d),
    };
    byMailbox.set(row.mailbox_id, activity);
    addInto(totals, activity);
  }

  return { byMailbox, totals };
}

/** Fallback: one read of the last week, tallied here. Capped, but transient. */
async function fromRows(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<WarmupActivityResult> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const today = now.toISOString().slice(0, 10);

  const { data } = await supabase
    .from("warmup_messages")
    .select(
      "from_mailbox_id, to_mailbox_id, is_reply, landed_in_spam, rescued, sent_at",
    )
    .eq("workspace_id", workspaceId)
    .gte("sent_at", since)
    .limit(20_000);

  const rows = (data ?? []) as {
    from_mailbox_id: string;
    to_mailbox_id: string;
    is_reply: boolean;
    landed_in_spam: boolean;
    rescued: boolean;
    sent_at: string;
  }[];

  const byMailbox = new Map<string, WarmupActivity>();
  const totals = emptyActivity();
  const get = (id: string) => {
    let activity = byMailbox.get(id);
    if (!activity) {
      activity = emptyActivity();
      byMailbox.set(id, activity);
    }
    return activity;
  };

  for (const row of rows) {
    const isToday = row.sent_at.slice(0, 10) === today;
    const sender = get(row.from_mailbox_id);
    sender.sent7d += 1;
    if (isToday) sender.sentToday += 1;
    if (row.is_reply) {
      sender.replied7d += 1;
      if (isToday) sender.repliedToday += 1;
    }
    if (row.landed_in_spam) sender.inSpam7d += 1;
    if (row.rescued) sender.rescued7d += 1;

    const recipient = get(row.to_mailbox_id);
    recipient.received7d += 1;
    if (isToday) recipient.receivedToday += 1;
  }

  for (const activity of byMailbox.values()) addInto(totals, activity);
  return { byMailbox, totals };
}

function addInto(target: WarmupActivity, source: WarmupActivity): void {
  target.sentToday += source.sentToday;
  target.receivedToday += source.receivedToday;
  target.repliedToday += source.repliedToday;
  target.sent7d += source.sent7d;
  target.received7d += source.received7d;
  target.replied7d += source.replied7d;
  target.inSpam7d += source.inSpam7d;
  target.rescued7d += source.rescued7d;
}
