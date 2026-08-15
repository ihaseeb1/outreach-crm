import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { suppressEmail } from "@/mail/suppressions";
import type { SuppressionReason } from "@/types/db";

/**
 * The single place that takes a contact out of active outreach.
 *
 * Every "stop emailing this person" path funnels through here — a won deal, a
 * lost deal, a manual stage move, an explicit stop button. Having one function
 * means a new stop trigger cannot forget half the job: the in-flight sequences
 * and the suppression list are always updated together.
 *
 * Stopping is not the same as suppressing. Stopping ends the sequences that are
 * running now; suppressing also blocks every future campaign, because canSend()
 * checks the suppression list on every send. A won deal should stop but usually
 * not suppress — you may want to pitch the same site again next quarter. A
 * "not a fit" or an opt-out should do both.
 */

export interface StopOutreachInput {
  workspaceId: string;
  contactId: string;
  /** Shown in the UI on the campaign contact row, so keep it human-readable. */
  reason: string;
  /** Also add the address to the suppression list — blocks all future sends. */
  suppress?: boolean;
  suppressionReason?: SuppressionReason;
  actorId?: string | null;
}

export interface StopOutreachResult {
  /** How many in-flight campaign enrolments were ended. */
  stopped: number;
  suppressed: boolean;
  email: string | null;
}

export async function stopOutreachForContact(
  supabase: SupabaseClient,
  input: StopOutreachInput,
): Promise<StopOutreachResult> {
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("id, email")
    .eq("id", input.contactId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  const contact = contactRow as { id: string; email: string } | null;
  if (!contact) return { stopped: 0, suppressed: false, email: null };

  // Only sequences that are still live. A contact already marked replied,
  // bounced or unsubscribed keeps that more specific status.
  const { data: ended } = await supabase
    .from("campaign_contacts")
    .update({
      status: "completed",
      next_send_at: null,
      locked_until: null,
      paused_reason: input.reason,
    })
    .eq("workspace_id", input.workspaceId)
    .eq("contact_id", contact.id)
    .in("status", ["pending", "active"])
    .select("id");

  const stopped = (ended ?? []).length;

  if (input.suppress) {
    await suppressEmail(supabase, {
      workspaceId: input.workspaceId,
      email: contact.email,
      reason: input.suppressionReason ?? "manual",
      source: "pipeline",
      meta: { note: input.reason },
      actorId: input.actorId ?? null,
    });
  }

  if (stopped > 0 || input.suppress) {
    await logActivity(supabase, {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      action: "outreach.stopped",
      entityType: "contact",
      entityId: contact.id,
      meta: {
        email: contact.email,
        reason: input.reason,
        sequences_stopped: stopped,
        suppressed: Boolean(input.suppress),
      },
    });
  }

  return { stopped, suppressed: Boolean(input.suppress), email: contact.email };
}

export interface TerminalStage {
  key: string;
  label: string;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * Looks up a stage and reports whether landing on it should end outreach.
 * Returns null for a stage that is not terminal, so callers can skip the work.
 */
export async function terminalStage(
  supabase: SupabaseClient,
  workspaceId: string,
  stageKey: string,
): Promise<TerminalStage | null> {
  const { data } = await supabase
    .from("pipeline_stages")
    .select("key, label, is_won, is_lost")
    .eq("workspace_id", workspaceId)
    .eq("key", stageKey)
    .maybeSingle();

  const stage = data as TerminalStage | null;
  if (!stage) return null;
  return stage.is_won || stage.is_lost ? stage : null;
}

/**
 * Deal statuses that mean the conversation is over.
 *
 * `live` is a placed link — the work is done, stop the follow-ups. `rejected`
 * is a refusal, which additionally suppresses so no later campaign re-pitches
 * someone who already said no.
 */
export function dealStatusStops(
  status: string,
): { reason: string; suppress: boolean; suppressionReason: SuppressionReason } | null {
  switch (status) {
    case "live":
      return { reason: "Deal closed — link is live", suppress: false, suppressionReason: "manual" };
    case "agreed":
      return { reason: "Deal agreed", suppress: false, suppressionReason: "manual" };
    case "rejected":
      return { reason: "Deal rejected", suppress: true, suppressionReason: "opted_out" };
    default:
      return null;
  }
}
