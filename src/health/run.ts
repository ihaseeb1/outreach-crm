import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { checkAuthRecords, checkBlacklists, sendingDomain } from "@/health/dns";
import { rate, scoreMailbox, type HealthSignals } from "@/health/score";
import type { Mailbox } from "@/types/db";

/**
 * Daily health check.
 *
 * Writes one `mailbox_health` row per mailbox per day and, crucially, sets
 * `mailboxes.health_status`. A mailbox flipped to `paused` here stops sending
 * campaigns AND stops warming up — both paths consult the same field.
 *
 * Recovery is automatic: when the signals come good again, the status returns to
 * healthy, and warmup resumes from a reduced volume rather than the level it had
 * reached before (a resume spike is exactly what providers punish).
 */

export interface HealthRunResult {
  checked: number;
  paused: number;
  recovered: number;
  warnings: number;
}

const WINDOW_DAYS = 7;

export async function runHealthChecks(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string; mailboxId?: string } = {},
): Promise<HealthRunResult> {
  const limit = options.limit ?? 5;
  const result: HealthRunResult = {
    checked: 0,
    paused: 0,
    recovered: 0,
    warnings: 0,
  };

  const today = new Date().toISOString().slice(0, 10);

  let query = supabase
    .from("mailboxes")
    .select("*")
    .not("encrypted_credentials", "is", null)
    .limit(limit);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
  if (options.mailboxId) query = query.eq("id", options.mailboxId);

  const { data } = await query;
  const mailboxes = (data ?? []) as Mailbox[];

  // Skip mailboxes already checked today unless one was named explicitly.
  const { data: doneRows } = await supabase
    .from("mailbox_health")
    .select("mailbox_id")
    .eq("date", today)
    .in(
      "mailbox_id",
      mailboxes.map((mailbox) => mailbox.id),
    );
  const alreadyDone = new Set(
    ((doneRows ?? []) as { mailbox_id: string }[]).map((row) => row.mailbox_id),
  );

  for (const mailbox of mailboxes) {
    if (!options.mailboxId && alreadyDone.has(mailbox.id)) continue;

    const signals = await gatherSignals(supabase, mailbox);
    const verdict = scoreMailbox(signals);

    await supabase.from("mailbox_health").upsert(
      {
        mailbox_id: mailbox.id,
        workspace_id: mailbox.workspace_id,
        date: today,
        reputation_score: verdict.score,
        sent_7d: signals.sent7d,
        bounce_rate: signals.bounceRate,
        complaint_rate: signals.complaintRate,
        warmup_spam_rate: signals.warmupSpamRate,
        spf_ok: signals.spfOk,
        dkim_ok: signals.dkimOk,
        dmarc_ok: signals.dmarcOk,
        blacklists: signals.blacklists,
        status: verdict.status,
        issues: verdict.issues,
        checked_at: new Date().toISOString(),
      },
      { onConflict: "mailbox_id,date" },
    );

    result.checked += 1;
    if (verdict.status === "warning") result.warnings += 1;

    if (verdict.status !== mailbox.health_status) {
      await supabase
        .from("mailboxes")
        .update({
          health_status: verdict.status,
          paused_reason:
            verdict.status === "paused" ? verdict.issues.join(" ") : null,
        })
        .eq("id", mailbox.id);

      if (verdict.status === "paused") {
        result.paused += 1;
        await logActivity(supabase, {
          workspaceId: mailbox.workspace_id,
          action: "mailbox.auto_paused",
          entityType: "mailbox",
          entityId: mailbox.id,
          meta: { score: verdict.score, issues: verdict.issues },
        });
      } else if (mailbox.health_status === "paused") {
        result.recovered += 1;
        // Come back gently rather than at the volume that got it paused.
        await supabase
          .from("warmup_settings")
          .update({ current_daily_volume: 5, last_ramped_on: today })
          .eq("mailbox_id", mailbox.id);

        await logActivity(supabase, {
          workspaceId: mailbox.workspace_id,
          action: "mailbox.recovered",
          entityType: "mailbox",
          entityId: mailbox.id,
          meta: { score: verdict.score },
        });
      }
    }
  }

  return result;
}

async function gatherSignals(
  supabase: SupabaseClient,
  mailbox: Mailbox,
): Promise<HealthSignals> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  const { count: sentCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", mailbox.id)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .gte("sent_at", since);
  const sent7d = sentCount ?? 0;

  const { count: bounceCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", mailbox.id)
    .eq("direction", "inbound")
    .eq("is_bounce", true)
    .gte("received_at", since);
  const bounces = bounceCount ?? 0;

  // Complaints arrive as suppressions with reason 'complaint'; feedback loops
  // are not available for free on Gmail, so this is what we have.
  const { count: complaints } = await supabase
    .from("suppressions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", mailbox.workspace_id)
    .eq("reason", "complaint")
    .gte("created_at", since);

  const { count: warmupTotal } = await supabase
    .from("warmup_messages")
    .select("id", { count: "exact", head: true })
    .eq("to_mailbox_id", mailbox.id)
    .gte("sent_at", since);

  const { count: warmupSpam } = await supabase
    .from("warmup_messages")
    .select("id", { count: "exact", head: true })
    .eq("to_mailbox_id", mailbox.id)
    .eq("landed_in_spam", true)
    .gte("sent_at", since);

  const domain = sendingDomain(mailbox.email);
  const auth = domain
    ? await checkAuthRecords(supabase, domain)
    : { spfOk: false, dkimOk: false, dmarcOk: false, detail: { notes: [] } };
  const blacklists = domain ? await checkBlacklists(supabase, domain) : [];

  return {
    sent7d,
    bounceRate: rate(bounces, sent7d),
    complaintRate: rate(complaints ?? 0, sent7d),
    warmupSpamRate: rate(warmupSpam ?? 0, warmupTotal ?? 0),
    spfOk: auth.spfOk,
    dkimOk: auth.dkimOk,
    dmarcOk: auth.dmarcOk,
    blacklists: blacklists.map((hit) => hit.label),
  };
}
