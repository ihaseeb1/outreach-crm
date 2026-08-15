import type { SupabaseClient } from "@supabase/supabase-js";

export interface ActivityInput {
  workspaceId: string;
  action: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Never throws — logging must not break the caller.
 * Callers are responsible for keeping secrets out of `meta`.
 */
export async function logActivity(
  supabase: SupabaseClient,
  input: ActivityInput,
): Promise<void> {
  try {
    await supabase.from("activity_log").insert({
      workspace_id: input.workspaceId,
      actor_id: input.actorId ?? null,
      action: input.action,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      meta: input.meta ?? {},
    });
  } catch (error) {
    console.error("[activity] failed to write entry", {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
