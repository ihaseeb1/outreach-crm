import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeEmail } from "@/lib/email";
import { logActivity } from "@/lib/activity";
import type { SuppressionReason } from "@/types/db";

export interface SuppressInput {
  workspaceId: string;
  email: string;
  reason: SuppressionReason;
  source?: string;
  meta?: Record<string, unknown>;
  actorId?: string | null;
}

/**
 * Adds an address to the global suppression list. Idempotent: re-suppressing
 * an address is a no-op that keeps the original reason.
 *
 * Also mirrors the state onto the contact so the UI shows it, and (from phase 3
 * onwards) stops any in-flight sequence for that contact.
 */
export async function suppressEmail(
  supabase: SupabaseClient,
  input: SuppressInput,
): Promise<void> {
  const email = normalizeEmail(input.email);
  if (!email) return;

  await supabase
    .from("suppressions")
    .upsert(
      {
        workspace_id: input.workspaceId,
        email,
        reason: input.reason,
        source: input.source ?? null,
        meta: input.meta ?? {},
      },
      { onConflict: "workspace_id,email", ignoreDuplicates: true },
    );

  await supabase
    .from("contacts")
    .update({
      validation_status: input.reason === "hard_bounce" ? "bounced" : "suppressed",
    })
    .eq("workspace_id", input.workspaceId)
    .eq("email", email);

  await logActivity(supabase, {
    workspaceId: input.workspaceId,
    actorId: input.actorId ?? null,
    action: "suppression.added",
    entityType: "suppression",
    meta: { email, reason: input.reason, source: input.source ?? null },
  });
}

/** True when the address is on the workspace suppression list. */
export async function isSuppressed(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("suppressions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", normalizeEmail(email))
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Bulk variant for batch jobs — one query instead of N.
 * Returns the subset of `emails` that are suppressed, lowercased.
 */
export async function suppressedSubset(
  supabase: SupabaseClient,
  workspaceId: string,
  emails: string[],
): Promise<Set<string>> {
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (normalized.length === 0) return new Set();

  const { data } = await supabase
    .from("suppressions")
    .select("email")
    .eq("workspace_id", workspaceId)
    .in("email", normalized);

  return new Set(
    ((data ?? []) as { email: string }[]).map((row) => normalizeEmail(row.email)),
  );
}
