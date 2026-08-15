import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Warmup mail arriving in one of your own mailboxes.
 *
 * It is deliberately kept out of `messages` and out of the unified inbox —
 * warmup traffic is not correspondence, and mixing it in would bury real
 * replies. Phase 4 fills in the `warmup_messages` bookkeeping (marking a peer
 * message as opened/replied); until that table exists this is a no-op that
 * simply discards the mail.
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
  void supabase;
  void workspaceId;
  void input;
  // Phase 4 replaces this body.
}
