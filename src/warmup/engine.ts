import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { mailboxIsRested } from "@/campaigns/schedule";
import { WARMUP_HEADER } from "@/mail/inbound-classify";
import { loadMailboxProvider } from "@/mail/providers";
import { sendEmail } from "@/mail/send";
import { warmupMessage, warmupReply } from "@/warmup/content";
import {
  nextVolume,
  pickPeer,
  poolIsViable,
  quotaRemaining,
  shouldRampToday,
  shouldContinueThread,
  shouldReply,
  type PeerCandidate,
} from "@/warmup/plan";
import { newWarmupToken } from "@/warmup/token";
import type { Mailbox } from "@/types/db";

/**
 * Peer warmup engine.
 *
 * Your own mailboxes email each other, open and flag what arrives, rescue
 * anything that lands in spam, and reply to a realistic fraction of it.
 *
 * Guards, in order, every time:
 *   1. warmup enabled for the mailbox
 *   2. mailbox active and not health-paused  (a paused mailbox stops warmup too)
 *   3. rested since its last send
 *   4. within today's warmup volume
 *   5. canSend() inside sendEmail — so a suppressed address is never warmed to
 */

export interface WarmupRunResult {
  ramped: number;
  sent: number;
  engaged: number;
  rescued: number;
  replied: number;
  skipped: string[];
}

interface WarmupRow {
  id: string;
  mailbox_id: string;
  workspace_id: string;
  enabled: boolean;
  current_daily_volume: number;
  target_daily_volume: number;
  ramp_increment: number;
  reply_rate: number;
  last_ramped_on: string | null;
  started_at: string | null;
}

const SEND_BATCH = 5;

/** Advances the ramp for every enabled mailbox, at most once a day each. */
export async function rampWarmupVolumes(
  supabase: SupabaseClient,
  options: { workspaceId?: string } = {},
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  let query = supabase.from("warmup_settings").select("*").eq("enabled", true);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  const rows = (data ?? []) as WarmupRow[];

  let ramped = 0;
  for (const row of rows) {
    if (!shouldRampToday(row.last_ramped_on, today)) continue;

    // Only healthy mailboxes climb. A warning holds volume steady rather than
    // raising it into a problem.
    const { data: mailboxRow } = await supabase
      .from("mailboxes")
      .select("health_status, is_active")
      .eq("id", row.mailbox_id)
      .maybeSingle();

    const mailbox = mailboxRow as Pick<Mailbox, "health_status" | "is_active"> | null;
    if (!mailbox?.is_active || mailbox.health_status !== "healthy") {
      await supabase
        .from("warmup_settings")
        .update({ last_ramped_on: today })
        .eq("id", row.id);
      continue;
    }

    const volume = nextVolume({
      current: row.current_daily_volume,
      target: row.target_daily_volume,
      increment: row.ramp_increment,
    });

    await supabase
      .from("warmup_settings")
      .update({
        current_daily_volume: volume,
        last_ramped_on: today,
        started_at: row.started_at ?? new Date().toISOString(),
      })
      .eq("id", row.id);

    if (volume !== row.current_daily_volume) ramped += 1;
  }

  return ramped;
}

/** Sends a small batch of peer warmup emails. */
export async function runWarmupSends(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<{ sent: number; skipped: string[] }> {
  const budget = options.limit ?? SEND_BATCH;
  const skipped: string[] = [];
  let sent = 0;

  const pools = await loadPools(supabase, options.workspaceId);

  for (const [workspaceId, pool] of pools) {
    if (!poolIsViable(pool.length)) {
      skipped.push(
        `workspace ${workspaceId}: warmup needs at least 2 enabled mailboxes`,
      );
      continue;
    }

    const peers: PeerCandidate[] = pool.map((entry) => ({
      id: entry.mailbox.id,
      email: entry.mailbox.email,
      lastReceivedAt: entry.lastReceivedAt,
    }));

    for (const entry of pool) {
      if (sent >= budget) break;

      const { mailbox, settings, sentToday } = entry;

      if (!mailbox.is_active || mailbox.health_status === "paused") continue;
      if (quotaRemaining(settings.current_daily_volume, sentToday) <= 0) continue;
      if (
        !mailboxIsRested(
          mailbox.last_send_at,
          mailbox.min_gap_seconds,
          mailbox.max_gap_seconds,
        )
      ) {
        continue;
      }

      const peer = pickPeer(peers, mailbox.id);
      if (!peer) continue;

      const content = warmupMessage();
      const token = newWarmupToken(workspaceId);

      const outcome = await sendEmail(supabase, {
        workspaceId,
        mailboxId: mailbox.id,
        toEmail: peer.email,
        subject: content.subject,
        body: content.body,
        kind: "warmup",
        // Internal mail: no unsubscribe footer, no postal address.
        includeFooter: false,
        extraHeaders: { [WARMUP_HEADER]: token },
      });

      if (!outcome.ok) {
        skipped.push(`${mailbox.email} -> ${peer.email}: ${outcome.reason}`);
        continue;
      }

      await supabase.from("warmup_messages").insert({
        workspace_id: workspaceId,
        from_mailbox_id: mailbox.id,
        to_mailbox_id: peer.id,
        subject: content.subject,
        message_id: outcome.messageId,
        token,
      });

      sent += 1;
      entry.sentToday += 1;
      const target = peers.find((candidate) => candidate.id === peer.id);
      if (target) target.lastReceivedAt = new Date().toISOString();
    }
  }

  return { sent, skipped };
}

/**
 * The half of warmup that actually moves the needle: open what arrived, flag it
 * as important, and — most valuable of all — pull anything that landed in spam
 * back into the inbox.
 */
export async function runWarmupEngagement(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<{ engaged: number; rescued: number }> {
  const limit = options.limit ?? 3;
  let engaged = 0;
  let rescued = 0;

  let query = supabase
    .from("warmup_settings")
    .select("mailbox_id, workspace_id")
    .eq("enabled", true)
    .limit(limit);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  const rows = (data ?? []) as { mailbox_id: string; workspace_id: string }[];

  for (const row of rows) {
    const loaded = await loadMailboxProvider(supabase, row.mailbox_id);
    if (!loaded) continue;

    try {
      // 1. Rescue from spam. This is the signal that teaches the provider these
      //    messages are wanted.
      const spamFolder = await loaded.provider.findSpamFolder();
      if (spamFolder) {
        const junk = await loaded.provider.findByHeader(spamFolder, WARMUP_HEADER);
        if (junk.length > 0) {
          const moved = await loaded.provider.moveMessages(
            spamFolder,
            junk.map((ref) => ref.uid),
            "INBOX",
          );
          rescued += moved;

          const ids = junk
            .map((ref) => ref.messageId)
            .filter((id): id is string => Boolean(id));
          if (ids.length > 0) {
            await supabase
              .from("warmup_messages")
              .update({ landed_in_spam: true, rescued: moved > 0 })
              .eq("workspace_id", row.workspace_id)
              .in("message_id", ids);
          }
        }
      }

      // 2. Open and flag what is sitting in the inbox.
      const inbox = await loaded.provider.findByHeader("INBOX", WARMUP_HEADER);
      if (inbox.length > 0) {
        await loaded.provider.addFlags(
          "INBOX",
          inbox.map((ref) => ref.uid),
          ["\\Seen", "\\Flagged"],
        );
        engaged += inbox.length;

        const ids = inbox
          .map((ref) => ref.messageId)
          .filter((id): id is string => Boolean(id));
        if (ids.length > 0) {
          await supabase
            .from("warmup_messages")
            .update({ opened: true, delivered_at: new Date().toISOString() })
            .eq("workspace_id", row.workspace_id)
            .in("message_id", ids)
            .eq("opened", false);
        }
      }
    } catch (error) {
      await supabase
        .from("mailboxes")
        .update({
          last_error: `Warmup engagement: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
        .eq("id", row.mailbox_id);
    } finally {
      await loaded.provider.close().catch(() => undefined);
    }
  }

  return { engaged, rescued };
}

/**
 * Walks up the in_reply_to chain to find how deep a thread is and what started
 * it. Bounded at MAX_THREAD_WALK hops: a conversation never needs to be longer
 * than that, and a bound means a corrupt chain cannot loop forever.
 */
const MAX_THREAD_WALK = 6;

async function threadContext(
  supabase: SupabaseClient,
  row: { message_id: string | null; in_reply_to: string | null; workspace_id: string },
): Promise<{ depth: number; rootMessageId: string | null }> {
  if (!row.in_reply_to) {
    return { depth: 1, rootMessageId: row.message_id };
  }

  let depth = 1;
  let parentId: string | null = row.in_reply_to;
  let rootMessageId: string | null = row.in_reply_to;

  for (let hop = 0; hop < MAX_THREAD_WALK && parentId; hop += 1) {
    depth += 1;
    rootMessageId = parentId;

    // Annotated rather than inferred: parentId feeds the query whose result
    // reassigns it, and TypeScript reports that as circular otherwise.
    const parent: { in_reply_to: string | null } | null = (
      await supabase
        .from("warmup_messages")
        .select("in_reply_to")
        .eq("workspace_id", row.workspace_id)
        .eq("message_id", parentId)
        .maybeSingle()
    ).data as { in_reply_to: string | null } | null;

    parentId = parent?.in_reply_to ?? null;
  }

  return { depth, rootMessageId };
}

/** Replies to a realistic fraction of received warmup mail. */
export async function runWarmupReplies(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<{ replied: number }> {
  const limit = options.limit ?? 3;

  // Replies are candidates too now, so a thread can go a few turns deep.
  // shouldContinueThread decides which ones actually continue.
  let query = supabase
    .from("warmup_messages")
    .select(
      "id, workspace_id, from_mailbox_id, to_mailbox_id, subject, message_id, is_reply, in_reply_to",
    )
    .eq("opened", true)
    .eq("replied", false)
    .order("sent_at", { ascending: true })
    // Was limit * 4. Each candidate costs a settings lookup and, for replies, a
    // walk up the in_reply_to chain, and scanning a wide pool to reply to three
    // of them is what pushed the tick past its function timeout.
    .limit(limit * 2);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  const rows = (data ?? []) as {
    id: string;
    workspace_id: string;
    from_mailbox_id: string;
    to_mailbox_id: string;
    subject: string | null;
    message_id: string | null;
    is_reply: boolean;
    in_reply_to: string | null;
  }[];

  let replied = 0;

  for (const row of rows) {
    if (replied >= limit) break;

    const { data: settingsRow } = await supabase
      .from("warmup_settings")
      .select("reply_rate, enabled")
      .eq("mailbox_id", row.to_mailbox_id)
      .maybeSingle();

    const settings = settingsRow as { reply_rate: number; enabled: boolean } | null;
    if (!settings?.enabled) continue;

    const thread = await threadContext(supabase, row);

    if (!shouldContinueThread(thread.depth, thread.rootMessageId)) {
      // A one-off thread that has already had its single reply. Mark it done so
      // it stops being re-examined on every tick.
      await supabase
        .from("warmup_messages")
        .update({ replied: true, replied_at: null })
        .eq("id", row.id);
      continue;
    }

    // reply_rate only governs whether a thread gets going at all. Once a
    // conversation is under way, abandoning it halfway would leave exactly the
    // dead-end thread this feature exists to avoid.
    if (thread.depth === 1 && !shouldReply(settings.reply_rate)) {
      // Deliberately left unreplied — a 100% reply rate is itself a tell.
      await supabase
        .from("warmup_messages")
        .update({ replied: true, replied_at: null })
        .eq("id", row.id);
      continue;
    }

    const { data: senderRow } = await supabase
      .from("mailboxes")
      .select("email")
      .eq("id", row.from_mailbox_id)
      .maybeSingle();
    const senderEmail = (senderRow as { email: string } | null)?.email;
    if (!senderEmail) continue;

    const token = newWarmupToken(row.workspace_id);
    const subject = row.subject?.startsWith("Re: ")
      ? row.subject
      : `Re: ${row.subject ?? "Quick update"}`;

    const outcome = await sendEmail(supabase, {
      workspaceId: row.workspace_id,
      mailboxId: row.to_mailbox_id,
      toEmail: senderEmail,
      subject,
      body: warmupReply(),
      kind: "warmup",
      includeFooter: false,
      inReplyTo: row.message_id,
      references: row.message_id ? [row.message_id] : undefined,
      extraHeaders: { [WARMUP_HEADER]: token },
    });

    if (!outcome.ok) continue;

    await supabase
      .from("warmup_messages")
      .update({ replied: true, replied_at: new Date().toISOString() })
      .eq("id", row.id);

    await supabase.from("warmup_messages").insert({
      workspace_id: row.workspace_id,
      from_mailbox_id: row.to_mailbox_id,
      to_mailbox_id: row.from_mailbox_id,
      subject,
      message_id: outcome.messageId,
      token,
      is_reply: true,
      in_reply_to: row.message_id,
    });

    replied += 1;
  }

  return { replied };
}

/** One tick of the whole warmup engine. */
export async function runWarmupBatch(
  supabase: SupabaseClient,
  options: {
    workspaceId?: string;
    sendLimit?: number;
    /** Mailboxes to open/flag/rescue per run. IMAP-bound, so keep it small. */
    engageLimit?: number;
    budgetMs?: number;
  } = {},
): Promise<WarmupRunResult> {
  // Engagement talks to IMAP for every mailbox it touches, which at three
  // mailboxes a run was enough to blow the 60s function limit on its own. One
  // per run, guarded by a budget, so a slow provider degrades this into doing
  // less rather than into returning nothing.
  const budgetMs = options.budgetMs ?? 40_000;
  const startedAt = Date.now();
  const spare = (reserve: number) => Date.now() - startedAt + reserve <= budgetMs;

  const ramped = await rampWarmupVolumes(supabase, options);
  const { sent, skipped } = await runWarmupSends(supabase, {
    workspaceId: options.workspaceId,
    limit: options.sendLimit ?? SEND_BATCH,
  });

  let engaged = 0;
  let rescued = 0;
  if (spare(20_000)) {
    const engagement = await runWarmupEngagement(supabase, {
      workspaceId: options.workspaceId,
      limit: options.engageLimit ?? 1,
    });
    engaged = engagement.engaged;
    rescued = engagement.rescued;
  } else {
    skipped.push("engagement skipped — out of time this run");
  }

  let replied = 0;
  if (spare(8_000)) {
    replied = (await runWarmupReplies(supabase, options)).replied;
  } else {
    skipped.push("replies skipped — out of time this run");
  }

  if (rescued > 0) {
    // Worth surfacing: warmup landing in spam is the earliest free signal that
    // a mailbox's reputation is slipping.
    const workspaceId = options.workspaceId;
    if (workspaceId) {
      await logActivity(supabase, {
        workspaceId,
        action: "warmup.rescued_from_spam",
        meta: { count: rescued },
      });
    }
  }

  return { ramped, sent, engaged, rescued, replied, skipped };
}

interface PoolEntry {
  mailbox: Mailbox;
  settings: WarmupRow;
  sentToday: number;
  lastReceivedAt: string | null;
}

/** Warmup-enabled mailboxes, grouped by workspace, with today's counts. */
async function loadPools(
  supabase: SupabaseClient,
  workspaceId?: string,
): Promise<Map<string, PoolEntry[]>> {
  let query = supabase.from("warmup_settings").select("*").eq("enabled", true);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data } = await query;
  const settings = (data ?? []) as WarmupRow[];
  if (settings.length === 0) return new Map();

  const { data: mailboxRows } = await supabase
    .from("mailboxes")
    .select("*")
    .in(
      "id",
      settings.map((row) => row.mailbox_id),
    );
  const mailboxes = new Map(
    ((mailboxRows ?? []) as Mailbox[]).map((mailbox) => [mailbox.id, mailbox]),
  );

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const pools = new Map<string, PoolEntry[]>();

  for (const row of settings) {
    const mailbox = mailboxes.get(row.mailbox_id);
    if (!mailbox) continue;

    const { count } = await supabase
      .from("warmup_messages")
      .select("id", { count: "exact", head: true })
      .eq("from_mailbox_id", mailbox.id)
      .gte("sent_at", since.toISOString());

    const { data: lastReceived } = await supabase
      .from("warmup_messages")
      .select("sent_at")
      .eq("to_mailbox_id", mailbox.id)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const list = pools.get(row.workspace_id) ?? [];
    list.push({
      mailbox,
      settings: row,
      sentToday: count ?? 0,
      lastReceivedAt: (lastReceived as { sent_at: string } | null)?.sent_at ?? null,
    });
    pools.set(row.workspace_id, list);
  }

  return pools;
}
