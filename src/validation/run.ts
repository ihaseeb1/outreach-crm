import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { suppressedSubset } from "@/mail/suppressions";
import { validateEmail } from "@/validation/validate";
import type { Contact } from "@/types/db";

export interface ValidationBatchResult {
  processed: number;
  valid: number;
  invalid: number;
  suppressed: number;
}

/**
 * Cron batch: validate up to `limit` contacts still marked `unknown`.
 * Idempotent — it only ever touches rows whose status is still `unknown`,
 * and re-running simply picks up whatever is left.
 */
export async function runValidationBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<ValidationBatchResult> {
  const limit = options.limit ?? 100;

  let query = supabase
    .from("contacts")
    .select("id, workspace_id, email")
    .eq("validation_status", "unknown")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  const contacts = (data ?? []) as Pick<Contact, "id" | "workspace_id" | "email">[];

  const result: ValidationBatchResult = {
    processed: 0,
    valid: 0,
    invalid: 0,
    suppressed: 0,
  };
  if (contacts.length === 0) return result;

  // Suppression always wins over a DNS-derived verdict.
  const byWorkspace = new Map<string, string[]>();
  for (const contact of contacts) {
    const list = byWorkspace.get(contact.workspace_id) ?? [];
    list.push(contact.email);
    byWorkspace.set(contact.workspace_id, list);
  }
  const suppressedByWorkspace = new Map<string, Set<string>>();
  for (const [workspaceId, emails] of byWorkspace) {
    suppressedByWorkspace.set(
      workspaceId,
      await suppressedSubset(supabase, workspaceId, emails),
    );
  }

  for (const contact of contacts) {
    const suppressed = suppressedByWorkspace
      .get(contact.workspace_id)
      ?.has(contact.email.toLowerCase());

    const verdict = suppressed
      ? { status: "suppressed" as const, mxHost: null, isRole: false }
      : await validateEmail(contact.email);

    await supabase
      .from("contacts")
      .update({
        validation_status: verdict.status,
        validated_at: new Date().toISOString(),
        meta: {
          mx_host: verdict.mxHost,
          is_role_account: verdict.isRole,
        },
      })
      .eq("id", contact.id)
      .eq("validation_status", "unknown");

    result.processed += 1;
    if (verdict.status === "valid" || verdict.status === "role_account") result.valid += 1;
    else if (verdict.status === "suppressed") result.suppressed += 1;
    else result.invalid += 1;
  }

  const workspaceIds = [...byWorkspace.keys()];
  for (const workspaceId of workspaceIds) {
    await logActivity(supabase, {
      workspaceId,
      action: "validation.batch",
      meta: { ...result },
    });
  }

  return result;
}
