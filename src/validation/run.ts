import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { suppressEmail, suppressedSubset } from "@/mail/suppressions";
import {
  isHoldStatus,
  isSendableStatus,
  isUndeliverableStatus,
  verifyEmail,
  type VerificationMode,
  type VerificationResult,
} from "@/validation/verify-engine";
import type { Contact } from "@/types/db";

export interface ValidationBatchResult {
  processed: number;
  valid: number;
  invalid: number;
  suppressed: number;
  /** Undeliverable contacts deleted from the list (and suppressed). */
  removed: number;
  /** Passed the quick check; queued for a deep (power) SMTP check. */
  queuedForPower: number;
  /** Left untouched to retry — a transient DNS/network failure, not a verdict. */
  deferred: number;
}

type Candidate = Pick<Contact, "id" | "workspace_id" | "email" | "meta">;

const CANDIDATE_COLUMNS = "id, workspace_id, email, meta";

function emptyResult(): ValidationBatchResult {
  return {
    processed: 0,
    valid: 0,
    invalid: 0,
    suppressed: 0,
    removed: 0,
    queuedForPower: 0,
    deferred: 0,
  };
}

/**
 * Cron batch: quick-verify up to `limit` contacts still marked `unknown`.
 *
 * Runs anywhere (no port 25 needed). Undeliverable addresses are removed and
 * suppressed on the spot; the ones that pass are flagged so the power worker can
 * confirm the mailbox exists.
 */
export async function runValidationBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<ValidationBatchResult> {
  const limit = options.limit ?? 100;

  let query = supabase
    .from("contacts")
    .select(CANDIDATE_COLUMNS)
    .eq("validation_status", "unknown")
    // Only rows never checked. A quick check that lands back on `unknown` (a
    // gibberish-looking address held for a power check) stamps `validated_at`, so
    // it drops out of this query instead of being re-selected every tick and
    // starving newer contacts. Genuinely transient failures leave `validated_at`
    // null on purpose, so those still get retried.
    .is("validated_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  return applyVerdicts(supabase, (data ?? []) as Candidate[], {
    force: false,
    mode: "quick",
  });
}

type RevalidateCandidate = Pick<
  Contact,
  "id" | "workspace_id" | "email" | "meta" | "validation_status" | "validated_at"
>;

const REVALIDATE_COLUMNS =
  "id, workspace_id, email, meta, validation_status, validated_at";

/**
 * Cron batch: re-verify contacts whose verdict is stale — and, first, contacts
 * sitting on unhealthy (warning/paused) mailboxes.
 *
 * The regular batch only ever touches `unknown` contacts, so a list that was
 * marked `valid` months ago (or by an older engine) never gets re-checked, and
 * its dead addresses keep bouncing forever — which is exactly how a mailbox
 * lands in `warning`/`paused` and stays there. This batch closes that hole:
 *
 *   Pass 1 — contacts in active/pending sequences on mailboxes whose
 *            health_status is not `healthy`. These are the lists generating
 *            bounces right now.
 *   Pass 2 — the oldest verdicts (default: validated over 90 days ago).
 *
 * Runs anywhere (quick mode, no port 25). Undeliverable addresses are
 * suppressed, stopped in their campaigns, and removed per the workspace's
 * auto-purge setting — the same treatment as the regular batch.
 */
export async function runRevalidationBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string; staleDays?: number } = {},
): Promise<ValidationBatchResult> {
  const limit = options.limit ?? 100;
  const staleDays = options.staleDays ?? 90;
  const staleCutoff = new Date(
    Date.now() - staleDays * 86400 * 1000,
  ).toISOString();
  // Don't churn the same addresses every tick — a week between re-checks.
  const recentCutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

  const seen = new Set<string>();
  const candidates: RevalidateCandidate[] = [];
  const take = (rows: RevalidateCandidate[]) => {
    for (const row of rows) {
      if (candidates.length >= limit || seen.has(row.id)) continue;
      // Already-undeliverable rows were handled when first found; re-checking
      // them every cycle is pure churn.
      if (isUndeliverableStatus(row.validation_status)) continue;
      seen.add(row.id);
      candidates.push(row);
    }
  };

  // Pass 1 — unhealthy mailboxes' active contacts.
  const { data: badBoxes } = await supabase
    .from("mailboxes")
    .select("id")
    .neq("health_status", "healthy")
    .limit(50);
  if (badBoxes && (badBoxes as { id: string }[]).length > 0) {
    const { data: ccRows } = await supabase
      .from("campaign_contacts")
      .select("contact_id")
      .in(
        "mailbox_id",
        (badBoxes as { id: string }[]).map((b) => b.id),
      )
      .in("status", ["active", "pending"])
      .limit(limit * 3);
    const contactIds = [
      ...new Set(
        ((ccRows ?? []) as { contact_id: string }[]).map((r) => r.contact_id),
      ),
    ].slice(0, limit);
    if (contactIds.length > 0) {
      let cQuery = supabase
        .from("contacts")
        .select(REVALIDATE_COLUMNS)
        .in("id", contactIds)
        .or(`validated_at.is.null,validated_at.lt.${recentCutoff}`);
      if (options.workspaceId)
        cQuery = cQuery.eq("workspace_id", options.workspaceId);
      const { data } = await cQuery;
      take((data ?? []) as RevalidateCandidate[]);
    }
  }

  // Pass 2 — oldest verdicts first.
  if (candidates.length < limit) {
    let sQuery = supabase
      .from("contacts")
      .select(REVALIDATE_COLUMNS)
      .lt("validated_at", staleCutoff)
      .order("validated_at", { ascending: true })
      .limit(limit - candidates.length);
    if (options.workspaceId)
      sQuery = sQuery.eq("workspace_id", options.workspaceId);
    const { data } = await sQuery;
    take((data ?? []) as RevalidateCandidate[]);
  }

  return applyVerdicts(supabase, candidates, {
    force: true,
    mode: "quick",
  });
}

/**
 * Deep (power) verification — run by `scripts/verify-worker.ts` on a box where
 * outbound port 25 is open. Picks contacts that passed the quick check and are
 * flagged `meta.needs_power`, opens a real SMTP conversation with each MX to
 * confirm the mailbox exists, and removes any that come back undeliverable.
 */
export async function runPowerVerificationBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<ValidationBatchResult> {
  const limit = options.limit ?? 25;

  let query = supabase
    .from("contacts")
    .select(CANDIDATE_COLUMNS)
    .contains("meta", { needs_power: true })
    .order("validated_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data } = await query;
  return applyVerdicts(supabase, (data ?? []) as Candidate[], {
    force: true,
    mode: "power",
  });
}

/**
 * Validates named contacts on demand, from the Contacts / Verify screen.
 * `force` re-checks a contact that already has a verdict.
 */
export async function validateContacts(
  supabase: SupabaseClient,
  options: {
    workspaceId: string;
    ids: string[];
    force?: boolean;
    mode?: VerificationMode;
  },
): Promise<ValidationBatchResult> {
  if (options.ids.length === 0) return emptyResult();

  let query = supabase
    .from("contacts")
    .select(CANDIDATE_COLUMNS)
    .eq("workspace_id", options.workspaceId)
    .in("id", options.ids);

  if (!options.force) query = query.eq("validation_status", "unknown");

  const { data } = await query;
  return applyVerdicts(supabase, (data ?? []) as Candidate[], {
    force: options.force ?? false,
    mode: options.mode ?? "quick",
  });
}

/** A real deliverable envelope sender per workspace, needed for power probes. */
async function mailFromFor(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("mailboxes")
    .select("email")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { email: string } | null)?.email ?? null;
}

/** Whether this workspace wants undeliverable contacts auto-deleted. */
async function autoPurgeEnabled(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .maybeSingle();
  const settings = (data as { settings: Record<string, unknown> | null } | null)?.settings ?? {};
  const verification = (settings.verification ?? {}) as Record<string, unknown>;
  // Default ON: the whole point is a clean list with a low bounce rate.
  return verification.auto_purge !== false;
}

async function applyVerdicts(
  supabase: SupabaseClient,
  contacts: Candidate[],
  options: { force: boolean; mode: VerificationMode },
): Promise<ValidationBatchResult> {
  const result = emptyResult();
  if (contacts.length === 0) return result;

  const workspaceIds = [...new Set(contacts.map((c) => c.workspace_id))];

  // Suppression always wins over a freshly-computed verdict.
  const suppressedByWorkspace = new Map<string, Set<string>>();
  const mailFromByWorkspace = new Map<string, string | null>();
  const purgeByWorkspace = new Map<string, boolean>();
  for (const workspaceId of workspaceIds) {
    const emails = contacts
      .filter((c) => c.workspace_id === workspaceId)
      .map((c) => c.email);
    suppressedByWorkspace.set(
      workspaceId,
      await suppressedSubset(supabase, workspaceId, emails),
    );
    mailFromByWorkspace.set(
      workspaceId,
      options.mode === "power" ? await mailFromFor(supabase, workspaceId) : null,
    );
    purgeByWorkspace.set(workspaceId, await autoPurgeEnabled(supabase, workspaceId));
  }

  for (const contact of contacts) {
    const alreadySuppressed = suppressedByWorkspace
      .get(contact.workspace_id)
      ?.has(contact.email.toLowerCase());

    if (alreadySuppressed) {
      let update = supabase
        .from("contacts")
        .update({
          validation_status: "suppressed",
          validated_at: new Date().toISOString(),
          // Clear the power-check flag so the worker stops re-probing a dead row.
          meta: { ...(contact.meta ?? {}), needs_power: false },
        })
        .eq("id", contact.id);
      if (!options.force) update = update.eq("validation_status", "unknown");
      await update;
      result.processed += 1;
      result.suppressed += 1;
      continue;
    }

    const verification = await verifyEmail(contact.email, {
      mode: options.mode,
      mailFrom: mailFromByWorkspace.get(contact.workspace_id) ?? undefined,
    });

    // A transient MX lookup failure must NEVER write the contact off. Leave the
    // row exactly as it was (validated_at stays null, so the cron retries it)
    // rather than recording a verdict built on a lookup that simply broke.
    if (verification.status === "unknown" && verification.mxLookupFailed) {
      result.processed += 1;
      result.deferred += 1;
      continue;
    }

    result.processed += 1;

    // Undeliverable → suppress + (optionally) delete. This is what keeps the
    // bounce rate down: a bad address never gets a chance to be emailed.
    if (isUndeliverableStatus(verification.status)) {
      result.invalid += 1;
      await suppressEmail(supabase, {
        workspaceId: contact.workspace_id,
        email: contact.email,
        reason: "manual",
        source: `verification:${verification.status}`,
        meta: verificationMeta(verification),
      });
      result.suppressed += 1;

      // Stop the address in every running sequence FIRST, before the row is
      // (optionally) deleted below. Without this, the contact's
      // campaign_contacts rows stay active — either orphaned (contact gone,
      // sends fail) or still being attempted. A bounced/stopped row also keeps
      // the honest audit trail instead of silently vanishing.
      await supabase
        .from("campaign_contacts")
        .update({
          status: "bounced",
          paused_reason: `Undeliverable (${verification.status})`,
          next_send_at: null,
          locked_until: null,
        })
        .eq("contact_id", contact.id)
        .in("status", ["pending", "active"]);

      if (purgeByWorkspace.get(contact.workspace_id)) {
        const { error } = await supabase.from("contacts").delete().eq("id", contact.id);
        if (!error) result.removed += 1;
      } else {
        // Kept on the list (purge off) — clear the power flag so it is not
        // re-probed forever, and stamp the real status.
        await supabase
          .from("contacts")
          .update({
            validation_status: verification.status,
            validated_at: new Date().toISOString(),
            meta: {
              ...(contact.meta ?? {}),
              verification: verificationMeta(verification),
              needs_power: false,
            },
          })
          .eq("id", contact.id);
      }
      continue;
    }

    // Store the verdict and decide whether a (further) power check is wanted.
    // "MX is good but the mailbox is unconfirmed" covers both the sendable
    // statuses and `unknown` (e.g. a gibberish-looking address held back from
    // campaigns until confirmed) — all of them benefit from a deep SMTP check.
    // After a power check that could not actually reach SMTP (port 25 blocked on
    // this host), keep it queued so a run on a host that allows port 25 can
    // still confirm it, rather than silently marking it "done" unchecked.
    const unconfirmed =
      isSendableStatus(verification.status) || isHoldStatus(verification.status);
    const smtpInconclusive =
      options.mode === "power" && verification.canConnectSmtp !== true;
    const needsPower =
      unconfirmed && (options.mode === "quick" || smtpInconclusive);
    const meta = {
      ...(contact.meta ?? {}),
      verification: verificationMeta(verification),
      mx_host: verification.mxRecords[0] ?? null,
      is_role_account: verification.isRoleAccount,
      needs_power: needsPower,
    };

    let update = supabase
      .from("contacts")
      .update({
        validation_status: verification.status,
        validated_at: new Date().toISOString(),
        meta,
      })
      .eq("id", contact.id);
    if (!options.force) update = update.eq("validation_status", "unknown");
    await update;

    if (isSendableStatus(verification.status)) result.valid += 1;
    else result.invalid += 1;
    if (needsPower) result.queuedForPower += 1;
  }

  for (const workspaceId of workspaceIds) {
    await logActivity(supabase, {
      workspaceId,
      action: "validation.batch",
      meta: { ...result, mode: options.mode, forced: options.force },
    });
  }

  return result;
}

function verificationMeta(result: VerificationResult): Record<string, unknown> {
  return {
    status: result.status,
    overall_score: result.overallScore,
    is_safe_to_send: result.isSafeToSend,
    is_valid_syntax: result.isValidSyntax,
    is_disposable: result.isDisposable,
    is_role_account: result.isRoleAccount,
    is_free_email: result.isFreeEmail,
    mx_accepts_mail: result.mxAcceptsMail,
    mx_records: result.mxRecords,
    can_connect_smtp: result.canConnectSmtp,
    is_catch_all: result.isCatchAll,
    has_inbox_full: result.hasInboxFull,
    is_disabled: result.isDisabled,
    is_deliverable: result.isDeliverable,
    is_spamtrap: result.isSpamtrap,
    did_you_mean: result.didYouMean,
    mode: result.mode,
    checked_at: result.checkedAt,
  };
}
