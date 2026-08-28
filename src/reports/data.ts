/**
 * Loading the Reports numbers without the 1000-row cap.
 *
 * The headline figures and the volume chart now come from `report_series` and
 * `mailbox_volume` (migration 0013), which count in the database and are never
 * touched by PostgREST's row limit. If those functions are not there yet — the
 * code always ships before the SQL is applied by hand — every loader here falls
 * back to the old read-the-rows-and-tally path so the page keeps working,
 * capped as before, until the migration lands.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  bucketSeries,
  densifyDaily,
  totals,
  type OutreachTotals,
  type SeriesPoint,
} from "@/reports/metrics";
import {
  summariseEngagement,
  type EngagementSummary,
} from "@/mail/tracking-summary";
import {
  summariseVolume,
  type MailboxVolume,
  type SentRow,
  REPORT_MAILBOX_WINDOWS,
} from "@/mailboxes/volume";
import type { ReportBucket } from "@/reports/ranges";

interface SeriesRow {
  day: string;
  sent: number;
  replies: number;
  bounces: number;
  opens: number;
  clicks: number;
  opened_emails: number;
  clicked_emails: number;
  tracked: number;
  click_tracked: number;
}

export interface ReportData {
  series: SeriesPoint[];
  summary: OutreachTotals;
  engagement: EngagementSummary;
  volumes: Record<string, MailboxVolume>;
  /** True when the numbers came from the uncapped SQL functions. */
  uncapped: boolean;
}

export async function loadReportData(
  supabase: SupabaseClient,
  options: {
    workspaceId: string;
    since: string;
    days: number;
    bucket: ReportBucket;
    /** Widest reach for the mailbox table, which has its own windows. */
    mailboxSince: string;
    now?: Date;
  },
): Promise<ReportData> {
  const now = options.now ?? new Date();

  const rpc = await loadFromRpc(supabase, options, now);
  if (rpc) return rpc;

  return loadFromRows(supabase, options, now);
}

/** The uncapped path: two aggregate functions, at most a few hundred rows. */
async function loadFromRpc(
  supabase: SupabaseClient,
  options: { workspaceId: string; since: string; days: number; bucket: ReportBucket },
  now: Date,
): Promise<ReportData | null> {
  const [seriesResult, volumeResult] = await Promise.all([
    supabase.rpc("report_series", {
      p_workspace: options.workspaceId,
      p_since: options.since,
    }),
    supabase.rpc("mailbox_volume", { p_workspace: options.workspaceId }),
  ]);

  // Either function missing (migration unapplied) sends us to the fallback.
  if (seriesResult.error || volumeResult.error) return null;

  const rows = (seriesResult.data ?? []) as SeriesRow[];

  const counts = new Map<string, { sent: number; replies: number; bounces: number }>();
  let opens = 0;
  let clicks = 0;
  let openedEmails = 0;
  let clickedEmails = 0;
  let tracked = 0;
  let clickTracked = 0;
  let sentTotal = 0;

  for (const row of rows) {
    counts.set(row.day, {
      sent: Number(row.sent),
      replies: Number(row.replies),
      bounces: Number(row.bounces),
    });
    sentTotal += Number(row.sent);
    opens += Number(row.opens);
    clicks += Number(row.clicks);
    openedEmails += Number(row.opened_emails);
    clickedEmails += Number(row.clicked_emails);
    tracked += Number(row.tracked);
    clickTracked += Number(row.click_tracked);
  }

  const daily = densifyDaily(options.days, counts, now);
  const series = bucketSeries(daily, options.bucket);

  const rate = (numerator: number, denominator: number) =>
    denominator <= 0 ? 0 : numerator / denominator;

  const engagement: EngagementSummary = {
    sent: sentTotal,
    tracked,
    clickTracked,
    openedEmails,
    clickedEmails,
    opens,
    clicks,
    openRate: rate(openedEmails, tracked),
    clickRate: rate(clickedEmails, tracked),
  };

  return {
    series,
    summary: totals(series),
    engagement,
    volumes: volumesFromRpc(volumeResult.data as MailboxVolumeRow[] | null),
    uncapped: true,
  };
}

interface MailboxVolumeRow {
  mailbox_id: string;
  today_outreach: number;
  today_warmup: number;
  d7_outreach: number;
  d7_warmup: number;
  d14_outreach: number;
  d14_warmup: number;
  d30_outreach: number;
  d30_warmup: number;
  d60_outreach: number;
  d60_warmup: number;
  d90_outreach: number;
  d90_warmup: number;
}

const WINDOW_DAYS = REPORT_MAILBOX_WINDOWS.map((window) => window.days);

/** Reshapes the wide per-mailbox rows into the MailboxVolume the table wants. */
function volumesFromRpc(
  rows: MailboxVolumeRow[] | null,
): Record<string, MailboxVolume> {
  const out: Record<string, MailboxVolume> = {};
  for (const row of rows ?? []) {
    const wide = row as unknown as Record<string, number>;
    const volume: MailboxVolume = {
      today: {
        outreach: Number(row.today_outreach),
        warmup: Number(row.today_warmup),
      },
    };
    for (const days of WINDOW_DAYS) {
      volume[days] = {
        outreach: Number(wide[`d${days}_outreach`] ?? 0),
        warmup: Number(wide[`d${days}_warmup`] ?? 0),
      };
    }
    out[row.mailbox_id] = volume;
  }
  return out;
}

/** The legacy capped path, kept only until migration 0013 is applied. */
async function loadFromRows(
  supabase: SupabaseClient,
  options: {
    workspaceId: string;
    since: string;
    days: number;
    bucket: ReportBucket;
    mailboxSince: string;
  },
  now: Date,
): Promise<ReportData> {
  const [{ data: sentRows }, { data: inboundRows }] = await Promise.all([
    supabase
      .from("messages")
      .select("sent_at, mailbox_id, meta")
      .eq("workspace_id", options.workspaceId)
      .eq("direction", "outbound")
      .eq("status", "sent")
      .gte("sent_at", options.mailboxSince)
      .limit(50_000),
    supabase
      .from("messages")
      .select("received_at, is_bounce, is_auto_reply")
      .eq("workspace_id", options.workspaceId)
      .eq("direction", "inbound")
      .gte("received_at", options.since)
      .limit(20_000),
  ]);

  const sinceMs = Date.parse(options.since);
  const sentInRange = ((sentRows ?? []) as {
    sent_at: string | null;
    meta: Record<string, unknown> | null;
  }[]).filter(
    (row) => Boolean(row.sent_at) && Date.parse(row.sent_at as string) >= sinceMs,
  );
  const sent = sentInRange.map((row) => row.sent_at as string);

  const inbound = (inboundRows ?? []) as {
    received_at: string | null;
    is_bounce: boolean;
    is_auto_reply: boolean;
  }[];

  const replies = inbound
    .filter((row) => !row.is_bounce && !row.is_auto_reply)
    .map((row) => row.received_at)
    .filter((value): value is string => Boolean(value));
  const bounces = inbound
    .filter((row) => row.is_bounce)
    .map((row) => row.received_at)
    .filter((value): value is string => Boolean(value));

  const daily = densifyDaily(
    options.days,
    tallyByDay(sent, replies, bounces),
    now,
  );
  const series = bucketSeries(daily, options.bucket);

  return {
    series,
    summary: totals(series),
    engagement: summariseEngagement(sentInRange.map((row) => row.meta)),
    volumes: summariseVolume(
      (sentRows ?? []) as SentRow[],
      now,
      WINDOW_DAYS,
    ),
    uncapped: false,
  };
}

function tallyByDay(
  sent: string[],
  replies: string[],
  bounces: string[],
): Map<string, { sent: number; replies: number; bounces: number }> {
  const counts = new Map<string, { sent: number; replies: number; bounces: number }>();
  const bump = (iso: string, key: "sent" | "replies" | "bounces") => {
    const day = iso.slice(0, 10);
    const found = counts.get(day) ?? { sent: 0, replies: 0, bounces: 0 };
    found[key] += 1;
    counts.set(day, found);
  };
  for (const iso of sent) bump(iso, "sent");
  for (const iso of replies) bump(iso, "replies");
  for (const iso of bounces) bump(iso, "bounces");
  return counts;
}
