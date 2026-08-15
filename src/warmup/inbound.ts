import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Warmup mail arriving in one of your own mailboxes.
 *
 * It is deliberately kept out of `messages` and out of the unified inbox —
 * warmup traffic is not correspondence, and mixing it in would bury real
 * replies. All that happens here is bookkeeping against `warmup_messages`.
 */

export interface WarmupInboundInput {
  fromEmail: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  warmupToken: string | null;
}

export async function recordWarmupInbound(
  supabase: SupabaseClient,
  workspaceId: string,
  input: WarmupInboundInput,
): Promise<void> {
  const now = new Date().toISOString();

  // A warmup reply landing back with the original sender closes the loop on
  // the message it answers.
  const parents = [input.inReplyTo, ...input.references].filter(
    (value): value is string => Boolean(value),
  );

  if (parents.length > 0) {
    await supabase
      .from("warmup_messages")
      .update({ replied: true, replied_at: now, delivered_at: now })
      .eq("workspace_id", workspaceId)
      .in("message_id", parents);
    return;
  }

  // Otherwise it is a fresh warmup message; the engagement pass will mark it
  // opened once it has been flagged in the folder.
  await supabase
    .from("warmup_messages")
    .update({ delivered_at: now })
    .eq("workspace_id", workspaceId)
    .eq("subject", input.subject)
    .is("delivered_at", null);
}
