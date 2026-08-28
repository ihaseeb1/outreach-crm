import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import {
  isWithinSendWindow,
  nextSendAt,
  resolveWindow,
  type ResolvedWindow,
} from "@/campaigns/schedule";
import {
  mailboxForContact,
  recordSend,
  type RotationMailbox,
} from "@/campaigns/rotation";
import { orderByPriority } from "@/campaigns/priority";
import { sendingAllowance } from "@/warmup/plan";
import { contactVars, renderTemplate } from "@/mail/template";
import { fetchSendingConfig, sendEmail } from "@/mail/send";
import type { TrackingMode } from "@/mail/tracking-summary";
import type {
  Campaign,
  CampaignContact,
  Contact,
  SequenceStep,
} from "@/types/db";

/**
 * The campaign runner.
 *
 * A bounded batch: claim due contacts, send at most `limit` emails, return.
 * Everything it needs is in Postgres, so a timeout mid-run loses nothing — the
 * claim lock expires and the contact is picked up on the next tick.
 *
 * Sends are gated by (in order): campaign status, the sending window, the
 * per-mailbox daily limit and rest gap, and finally canSend() inside sendEmail.
 */

export interface CampaignBatchResult {
  sent: number;
  skipped: number;
  failed: number;
  completed: number;
  stopped: number;
  notes: string[];
}

const MAX_ATTEMPTS = 3;

/** Leaves headroom under the 60s function limit for the final send to finish. */
const BATCH_BUDGET_MS = 45_000;

export async function runCampaignBatch(
  supabase: SupabaseClient,
  options: {
    limit?: number;
    workspaceId?: string;
    campaignId?: string;
    /**
     * Send even though the clock is outside the campaign's window.
     *
     * Only ever set from an explicit human "send now" — never by the cron. The
     * window exists to stop *unattended* sends landing at bad hours; somebody
     * pressing the button has already made that call, and refusing them means
     * an overnight schedule cannot be tested until overnight.
     */
    ignoreWindow?: boolean;
  } = {},
): Promise<CampaignBatchResult> {
  const budget = options.limit ?? 10;
  const result: CampaignBatchResult = {
    sent: 0,
    skipped: 0,
    failed: 0,
    completed: 0,
    stopped: 0,
    notes: [],
  };

  let query = supabase.from("campaigns").select("*").eq("status", "active");
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
  if (options.campaignId) query = query.eq("id", options.campaignId);

  const { data: campaignRows } = await query;
  const campaigns = (campaignRows ?? []) as Campaign[];

  const now = new Date();
  const ignoreWindow = options.ignoreWindow ?? false;

  // First pass: which campaigns may send this tick. A campaign outside its
  // window is skipped (noted) unless this is a manual, window-ignoring run.
  const windows = new Map<string, ResolvedWindow>();
  const sendable: Campaign[] = [];
  for (const campaign of campaigns) {
    const window = resolveWindow(campaign.settings);
    const inWindow = isWithinSendWindow(now, window);
    if (!ignoreWindow && !inWindow) {
      result.notes.push(`${campaign.name}: outside sending window`);
      continue;
    }
    if (ignoreWindow && !inWindow) {
      result.notes.push(
        `${campaign.name}: sent outside the window because this was a manual run`,
      );
    }
    windows.set(campaign.id, window);
    sendable.push(campaign);
  }

  // Gather every due contact across all sendable campaigns, then order them so
  // follow-ups (step >= 2) spend the tick's quota before any first-touch, and
  // so one freshly-enrolled campaign cannot starve the others (spec §2). The
  // ordering is a pure function; see campaigns/priority.ts.
  const due: CampaignContact[] = [];
  for (const campaign of sendable) {
    const rows = await loadDueContacts(supabase, campaign, budget, ignoreWindow);
    due.push(...rows);
  }
  const ordered = orderByPriority(due);

  // Second pass: process in priority order until the tick's send budget is
  // spent. Per-campaign resources (steps, mailboxes, sending config) are loaded
  // once and cached — an unusable campaign caches as null so its remaining
  // contacts are skipped without re-querying.
  const contexts = new Map<string, CampaignContext | null>();
  let remaining = budget;

  // Stops the batch before the 60s function limit so a larger budget can never
  // cut a send off mid-flight — the unsent contacts stay due for the next tick.
  // This bounds work per invocation; it does not touch any mailbox's send gap.
  const startedMs = Date.now();

  for (const entry of ordered) {
    if (remaining <= 0 || Date.now() - startedMs > BATCH_BUDGET_MS) break;

    let ctx = contexts.get(entry.campaign_id);
    if (ctx === undefined) {
      const campaign = sendable.find((c) => c.id === entry.campaign_id);
      ctx = campaign
        ? await loadCampaignContext(
            supabase,
            campaign,
            windows.get(campaign.id) ?? resolveWindow(campaign.settings),
            result,
          )
        : null;
      contexts.set(entry.campaign_id, ctx);
    }
    if (!ctx) continue; // no steps or no mailbox — note already recorded

    const { data: claimed } = await supabase.rpc("campaign_contact_claim", {
      contact_row: entry.id,
      lock_seconds: 300,
    });
    if (claimed !== true) continue;

    const outcome = await processCampaignContact(supabase, {
      campaign: ctx.campaign,
      entry,
      steps: ctx.steps,
      mailboxes: ctx.mailboxes,
      window: ctx.window,
      postalAddress: ctx.postalAddress,
      tracking: ctx.tracking,
    });

    switch (outcome) {
      case "sent":
        result.sent += 1;
        remaining -= 1;
        break;
      case "completed":
        result.completed += 1;
        break;
      case "stopped":
        result.stopped += 1;
        break;
      case "failed":
        result.failed += 1;
        break;
      default:
        result.skipped += 1;
    }
  }

  return result;
}

/** The due, unclaimed contacts for one campaign — capped so a big campaign
 * cannot pull the whole table into memory. Ordering across campaigns is done
 * afterwards by orderByPriority; the SQL order here only bounds *which* rows
 * a cap of budget*2 keeps (the oldest-due ones). */
async function loadDueContacts(
  supabase: SupabaseClient,
  campaign: Campaign,
  budget: number,
  ignoreWindow: boolean,
): Promise<CampaignContact[]> {
  const iso = new Date().toISOString();

  let dueQuery = supabase
    .from("campaign_contacts")
    .select("*")
    .eq("campaign_id", campaign.id)
    .in("status", ["pending", "active"])
    .or(`locked_until.is.null,locked_until.lt.${iso}`)
    .order("next_send_at", { ascending: true })
    .limit(budget * 2);

  if (ignoreWindow) {
    // Enrolment parks a contact's first send at the next window opening, so a
    // 1am-Monday campaign has nothing "due" until Monday. A manual start also
    // releases contacts that have never been sent to (current_step 0).
    //
    // Follow-ups deliberately keep their next_send_at: that timestamp encodes
    // the wait between steps, and firing step 2 early would chase somebody a
    // day after first contact.
    dueQuery = dueQuery.or(`next_send_at.lte.${iso},current_step.eq.0`);
  } else {
    dueQuery = dueQuery.lte("next_send_at", iso);
  }

  const { data } = await dueQuery;
  return (data ?? []) as CampaignContact[];
}

interface CampaignContext {
  campaign: Campaign;
  window: ResolvedWindow;
  steps: SequenceStep[];
  mailboxes: RotationMailbox[];
  postalAddress: string | null;
  tracking: TrackingMode;
}

/** Loads everything a campaign needs to send: its steps, its usable mailbox
 * pool, and the workspace's postal address + tracking mode (read once so
 * sendEmail does not re-fetch per contact). Returns null — and records why —
 * when the campaign has no steps or no usable mailbox. */
async function loadCampaignContext(
  supabase: SupabaseClient,
  campaign: Campaign,
  window: ResolvedWindow,
  result: CampaignBatchResult,
): Promise<CampaignContext | null> {
  const steps = await loadSteps(supabase, campaign.id);
  if (steps.length === 0) {
    result.notes.push(`${campaign.name}: no sequence steps`);
    return null;
  }

  const mailboxes = await loadMailboxes(supabase, campaign);
  if (mailboxes.length === 0) {
    result.notes.push(`${campaign.name}: no usable mailbox`);
    return null;
  }

  const { postalAddress, tracking } = await fetchSendingConfig(
    supabase,
    campaign.workspace_id,
  );

  return { campaign, window, steps, mailboxes, postalAddress, tracking };
}

type ContactOutcome = "sent" | "completed" | "stopped" | "failed" | "skipped";

interface ProcessInput {
  campaign: Campaign;
  entry: CampaignContact;
  steps: SequenceStep[];
  mailboxes: RotationMailbox[];
  window: ResolvedWindow;
  postalAddress: string | null;
  tracking: TrackingMode;
}

async function processCampaignContact(
  supabase: SupabaseClient,
  input: ProcessInput,
): Promise<ContactOutcome> {
  const { campaign, entry, steps, mailboxes, window } = input;
  const release = () => supabase.rpc("campaign_contact_release", { contact_row: entry.id });

  const stepNumber = entry.current_step + 1;
  const step = steps.find((candidate) => candidate.step_number === stepNumber);

  // Sequence exhausted — the contact simply never replied.
  if (!step) {
    await supabase
      .from("campaign_contacts")
      .update({
        status: "completed",
        next_send_at: null,
        locked_until: null,
      })
      .eq("id", entry.id);
    return "completed";
  }

  const { data: contactRow } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", entry.contact_id)
    .maybeSingle();

  if (!contactRow) {
    await supabase
      .from("campaign_contacts")
      .update({ status: "failed", last_error: "Contact no longer exists.", locked_until: null })
      .eq("id", entry.id);
    return "failed";
  }
  const contact = contactRow as Contact;

  const { mailbox, waiting, switched } = mailboxForContact(
    entry.mailbox_id,
    mailboxes,
  );
  if (!mailbox) {
    // Either every mailbox is at its limit / resting, or the assigned one is.
    // Leave the contact due and try again on the next tick.
    await release();
    return "skipped";
  }
  void waiting;

  if (switched) {
    // The mailbox this contact was on is paused or gone. The send below writes
    // the new mailbox_id, so every later step follows it too.
    await logActivity(supabase, {
      workspaceId: campaign.workspace_id,
      action: "campaign.mailbox_switched",
      entityType: "contact",
      entityId: entry.contact_id,
      meta: {
        campaign: campaign.name,
        step: stepNumber,
        from_mailbox: entry.mailbox_id,
        to_mailbox: mailbox.id,
        reason: "previous mailbox unavailable — paused, deactivated or removed",
      },
    });
  }

  // Follow-ups thread under the first email in the conversation.
  const thread = step.reply_to_thread && stepNumber > 1
    ? await loadThreadAnchor(supabase, campaign.id, entry.contact_id)
    : null;

  const vars = contactVars(contact, {
    step: String(stepNumber),
    campaign: campaign.name,
  });

  // Seeded on the recipient + step so spintax picks one variant and keeps it:
  // a retry or a threaded follow-up must not quietly rewrite what was sent.
  const spinSeed = `${contact.email}#${stepNumber}`;

  const subject = thread?.subject
    ? ensureReplyPrefix(thread.subject)
    : renderTemplate(step.subject_template, vars, `${spinSeed}#subject`);

  const outcome = await sendEmail(supabase, {
    workspaceId: campaign.workspace_id,
    mailboxId: mailbox.id,
    contactId: contact.id,
    campaignId: campaign.id,
    stepNumber,
    toEmail: contact.email,
    toName: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null,
    subject,
    body: renderTemplate(step.body_template, vars, `${spinSeed}#body`),
    kind: "campaign",
    inReplyTo: thread?.messageId ?? null,
    references: thread?.messageId ? [thread.messageId] : undefined,
    threadId: entry.thread_id ?? thread?.threadId ?? null,
    postalAddress: input.postalAddress,
    tracking: input.tracking,
  });

  if (outcome.ok) {
    // Write the send back into the pool before the loop picks again, or this
    // mailbox stays eligible for the rest of the batch and takes every contact.
    recordSend(mailbox);

    const nextStep = steps.find(
      (candidate) => candidate.step_number === stepNumber + 1,
    );

    await supabase
      .from("campaign_contacts")
      .update({
        current_step: stepNumber,
        status: nextStep ? "active" : "completed",
        mailbox_id: mailbox.id,
        thread_id: entry.thread_id ?? outcome.threadId,
        last_sent_at: new Date().toISOString(),
        next_send_at: nextStep
          ? nextSendAt({
              from: new Date(),
              delayDays: nextStep.delay_days,
              window,
            }).toISOString()
          : null,
        locked_until: null,
        last_error: null,
        // Reset the attempt counter on every successful send. The claim RPC
        // increments `attempts` on *every* claim (not every failure), and this
        // was never cleared — so across a few steps a contact accumulated
        // enough attempts that the next transient hiccup flipped it to "failed"
        // and it silently dropped out of the follow-up queue forever. Counting
        // attempts since the last success is what we actually want.
        attempts: 0,
      })
      .eq("id", entry.id);

    await supabase
      .from("contacts")
      .update({ pipeline_stage: "contacted" })
      .eq("id", contact.id)
      .eq("pipeline_stage", "new");

    return "sent";
  }

  // --- The send was refused or failed. ---
  return handleSendFailure(supabase, campaign, entry, outcome.code, outcome.reason);
}

/**
 * Sends one enrolled contact's current step immediately, ignoring the window
 * (spec §4.2 "Send now"). Reuses the exact same per-contact path as the batch —
 * suppression, daily cap and the closing block all still apply — so this can
 * never send something the scheduled run would refuse; it only skips the wait.
 * The caller is responsible for reactivating a failed/paused enrolment first.
 */
export async function sendCampaignContactNow(
  supabase: SupabaseClient,
  params: { workspaceId: string; campaignContactId: string },
): Promise<{ ok: boolean; outcome?: ContactOutcome; error?: string }> {
  const { data: ccRow } = await supabase
    .from("campaign_contacts")
    .select("*")
    .eq("id", params.campaignContactId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (!ccRow) return { ok: false, error: "Enrolment not found." };
  const entry = ccRow as CampaignContact;

  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", entry.campaign_id)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (!campaignRow) return { ok: false, error: "Campaign not found." };
  const campaign = campaignRow as Campaign;

  const steps = await loadSteps(supabase, campaign.id);
  if (steps.length === 0) return { ok: false, error: "Campaign has no sequence steps." };
  const mailboxes = await loadMailboxes(supabase, campaign);
  if (mailboxes.length === 0) {
    return { ok: false, error: "No active mailbox to send from." };
  }
  const { postalAddress, tracking } = await fetchSendingConfig(
    supabase,
    campaign.workspace_id,
  );

  const { data: claimed } = await supabase.rpc("campaign_contact_claim", {
    contact_row: entry.id,
    lock_seconds: 300,
  });
  if (claimed !== true) {
    return { ok: false, error: "This contact is already sending — try again shortly." };
  }

  const outcome = await processCampaignContact(supabase, {
    campaign,
    entry,
    steps,
    mailboxes,
    window: resolveWindow(campaign.settings),
    postalAddress,
    tracking,
  });

  return { ok: outcome === "sent" || outcome === "completed", outcome };
}

async function handleSendFailure(
  supabase: SupabaseClient,
  campaign: Campaign,
  entry: CampaignContact,
  code: string,
  reason: string,
): Promise<ContactOutcome> {
  // Terminal for this contact: they are on the suppression list.
  if (code === "suppressed" || code === "disposable" || code === "invalid_syntax") {
    await supabase
      .from("campaign_contacts")
      .update({
        status: "unsubscribed",
        next_send_at: null,
        locked_until: null,
        paused_reason: reason,
        last_error: reason,
      })
      .eq("id", entry.id);
    return "stopped";
  }

  if (code === "bounced") {
    await supabase
      .from("campaign_contacts")
      .update({
        status: "bounced",
        next_send_at: null,
        locked_until: null,
        paused_reason: reason,
        last_error: reason,
      })
      .eq("id", entry.id);
    return "stopped";
  }

  // Configuration problem — pause the whole campaign rather than burn through
  // every contact failing the same way.
  if (code === "missing_postal_address") {
    await supabase
      .from("campaigns")
      .update({ status: "paused" })
      .eq("id", campaign.id);
    await supabase
      .from("campaign_contacts")
      .update({ locked_until: null, last_error: reason })
      .eq("id", entry.id);

    await logActivity(supabase, {
      workspaceId: campaign.workspace_id,
      action: "campaign.paused",
      entityType: "campaign",
      entityId: campaign.id,
      meta: { reason },
    });
    return "stopped";
  }

  // Transient: mailbox full or resting. Retry on a later tick.
  if (code === "daily_limit_reached" || code === "mailbox_inactive") {
    await supabase
      .from("campaign_contacts")
      .update({ locked_until: null })
      .eq("id", entry.id);
    return "skipped";
  }

  const attempts = entry.attempts + 1;
  await supabase
    .from("campaign_contacts")
    .update({
      locked_until: null,
      last_error: reason,
      ...(attempts >= MAX_ATTEMPTS
        ? { status: "failed", next_send_at: null }
        : {}),
    })
    .eq("id", entry.id);

  return attempts >= MAX_ATTEMPTS ? "failed" : "skipped";
}

async function loadSteps(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<SequenceStep[]> {
  const { data } = await supabase
    .from("sequence_steps")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("step_number", { ascending: true });
  return (data ?? []) as SequenceStep[];
}

async function loadMailboxes(
  supabase: SupabaseClient,
  campaign: Campaign,
): Promise<RotationMailbox[]> {
  let query = supabase
    .from("mailboxes")
    .select(
      "id, email, daily_limit, sent_today, sent_today_date, min_gap_seconds, max_gap_seconds, last_send_at, is_active, health_status",
    )
    .eq("workspace_id", campaign.workspace_id)
    .eq("is_active", true)
    .neq("health_status", "paused");

  // An empty mailbox_ids list means "use every active mailbox".
  const ids = Array.isArray(campaign.mailbox_ids) ? campaign.mailbox_ids : [];
  if (ids.length > 0) query = query.in("id", ids);

  const { data } = await query;
  const mailboxes = (data ?? []) as RotationMailbox[];
  if (mailboxes.length === 0) return mailboxes;

  // Hold real sending to what warmup has actually reached. Rotation already
  // works off daily_limit, so folding the allowance into that field keeps the
  // capacity and rest rules in one place instead of two.
  const { data: warmupRows } = await supabase
    .from("warmup_settings")
    .select("mailbox_id, enabled, current_daily_volume, target_daily_volume")
    .in(
      "mailbox_id",
      mailboxes.map((mailbox) => mailbox.id),
    );

  const warmupByMailbox = new Map(
    ((warmupRows ?? []) as {
      mailbox_id: string;
      enabled: boolean;
      current_daily_volume: number;
      target_daily_volume: number;
    }[]).map((row) => [
      row.mailbox_id,
      {
        enabled: row.enabled,
        currentDailyVolume: row.current_daily_volume,
        targetDailyVolume: row.target_daily_volume,
      },
    ]),
  );

  return mailboxes.map((mailbox) => ({
    ...mailbox,
    daily_limit: sendingAllowance(
      mailbox.daily_limit,
      warmupByMailbox.get(mailbox.id) ?? null,
      mailbox.health_status,
    ),
  }));
}

interface ThreadAnchor {
  messageId: string | null;
  threadId: string | null;
  subject: string | null;
}

/** The first email we sent this contact in this campaign. */
async function loadThreadAnchor(
  supabase: SupabaseClient,
  campaignId: string,
  contactId: string,
): Promise<ThreadAnchor | null> {
  const { data } = await supabase
    .from("messages")
    .select("message_id, thread_id, subject")
    .eq("campaign_id", campaignId)
    .eq("contact_id", contactId)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const row = data as {
    message_id: string | null;
    thread_id: string | null;
    subject: string | null;
  };
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    subject: row.subject,
  };
}

export function ensureReplyPrefix(subject: string): string {
  return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`;
}


