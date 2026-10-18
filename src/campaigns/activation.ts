import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { preflight } from "@/campaigns/preflight";

export interface ScheduledActivationResult {
  /** Names of campaigns that were flipped to active. */
  activated: string[];
  /** Campaigns whose schedule was dropped because preflight failed. */
  failed: { name: string; reason: string }[];
}

interface DueCampaign {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  scheduled_activate_at: string;
}

/**
 * Activates draft/paused campaigns whose scheduled_activate_at has arrived.
 *
 * Runs on every engine tick (cheap: one indexed query, usually zero rows).
 * Each due campaign goes through the same preflight checks as a manual start:
 * on success it becomes active and the schedule is cleared; on failure the
 * schedule is cleared too and the reason is written to the activity log, so a
 * campaign never sits silently "scheduled" forever.
 *
 * The send window and send days are untouched — scheduling only decides WHEN
 * the campaign becomes active, never how it sends.
 */
export async function activateDueScheduledCampaigns(
  supabase: SupabaseClient,
): Promise<ScheduledActivationResult> {
  const result: ScheduledActivationResult = { activated: [], failed: [] };

  const { data, error } = await supabase
    .from("campaigns")
    .select("id, workspace_id, name, status, scheduled_activate_at")
    .not("scheduled_activate_at", "is", null)
    .lte("scheduled_activate_at", new Date().toISOString())
    .in("status", ["draft", "paused"])
    .limit(20);

  if (error || !data || data.length === 0) return result;

  for (const row of data as DueCampaign[]) {
    const problem = await preflight(supabase, row.workspace_id, row.id);

    if (problem) {
      await supabase
        .from("campaigns")
        .update({ scheduled_activate_at: null })
        .eq("id", row.id);
      await logActivity(supabase, {
        workspaceId: row.workspace_id,
        actorId: null,
        action: "campaign.schedule_failed",
        entityType: "campaign",
        entityId: row.id,
        meta: { name: row.name, reason: problem },
      });
      result.failed.push({ name: row.name, reason: problem });
      continue;
    }

    const { error: activateError } = await supabase
      .from("campaigns")
      .update({ status: "active", scheduled_activate_at: null })
      .eq("id", row.id);

    if (activateError) {
      result.failed.push({ name: row.name, reason: activateError.message });
      continue;
    }

    await logActivity(supabase, {
      workspaceId: row.workspace_id,
      actorId: null,
      action: "campaign.activated",
      entityType: "campaign",
      entityId: row.id,
      meta: { name: row.name, scheduled: true },
    });
    result.activated.push(row.name);
  }

  return result;
}
