import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Everything that must be true before a campaign is allowed to start sending.
 *
 * Used by the manual "Start sending" PATCH and by the scheduled-activation
 * engine step, so a campaign can never go live — by hand or by schedule —
 * without passing the same checks.
 */
export async function preflight(
  supabase: SupabaseClient,
  workspaceId: string,
  campaignId: string,
): Promise<string | null> {
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("sending_postal_address")
    .eq("id", workspaceId)
    .single();

  const postal = (workspace as { sending_postal_address: string | null } | null)
    ?.sending_postal_address;
  if (!postal || !postal.trim()) {
    return "Add a sending postal address in Settings first — CAN-SPAM requires it in every campaign email.";
  }

  const { count: stepCount } = await supabase
    .from("sequence_steps")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (!stepCount) {
    return "This campaign has no sequence steps yet.";
  }

  const { count: mailboxCount } = await supabase
    .from("mailboxes")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .neq("health_status", "paused");
  if (!mailboxCount) {
    return "No active mailbox is available to send from.";
  }

  const { count: contactCount } = await supabase
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (!contactCount) {
    return "Add some contacts to this campaign first.";
  }

  return null;
}
