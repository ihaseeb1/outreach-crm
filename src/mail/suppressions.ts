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
 * Also mirrors the state onto the contact so the UI shows it, and stops any
 * in-flight sequence for that contact.
 *
 * **One address can never be suppressed: your own.** Warmup mail now carries
 * the same closing block as real outreach, opt-out link included, and that link
 * is addressed to whichever of your mailboxes received the message. Gmail
 * prefetches and scans links, offers its own one-click unsubscribe from the
 * `List-Unsubscribe` header, and a person may simply click it to see what it
 * does. Any of those would put one of your own sending addresses on the
 * suppression list, and `canSend` would then refuse every warmup message to it —
 * quietly, since a skipped send looks the same as a rested mailbox. So the
 * guard lives here, at the single choke point every suppression path goes
 * through, rather than in the unsubscribe route alone.
 *
 * Returns false when nothing was suppressed, so a caller can say so.
 */
export async function suppressEmail(
  supabase: SupabaseClient,
  input: SuppressInput,
): Promise<boolean> {
  const email = normalizeEmail(input.email);
  if (!email) return false;

  if (await isOwnMailbox(supabase, input.workspaceId, email)) {
    await logActivity(supabase, {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      action: "suppression.refused_own_mailbox",
      meta: { email, reason: input.reason, source: input.source ?? null },
    });
    return false;
  }

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

  return true;
}

/** Is this address one of the workspace's own connected mailboxes? */
export async function isOwnMailbox(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const { data } = await supabase
    .from("mailboxes")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("email", normalized)
    .limit(1)
    .maybeSingle();

  return Boolean(data);
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

  // Chunked: `in` is a query string, and an enrolment of five thousand
  // addresses would build a URL the gateway rejects before Postgres sees it.
  const CHUNK = 200;
  const suppressed = new Set<string>();

  for (let i = 0; i < normalized.length; i += CHUNK) {
    const { data } = await supabase
      .from("suppressions")
      .select("email")
      .eq("workspace_id", workspaceId)
      .in("email", normalized.slice(i, i + CHUNK));

    for (const row of (data ?? []) as { email: string }[]) {
      suppressed.add(normalizeEmail(row.email));
    }
  }

  return suppressed;
}
