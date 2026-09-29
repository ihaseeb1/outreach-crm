import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { WARMUP_HEADER } from "@/mail/inbound-classify";
import { loadMailboxProvider } from "@/mail/providers";
import {
  ANOMALY_QUARANTINE_THRESHOLD,
  HARD_DELETE_GRACE_DAYS,
  isPastRetention,
  readDeletionSettings,
  resolveRetention,
  retentionCutoff,
  type RetentionRule,
} from "@/warmup/deletion";
import { loadWorkspacePools, type WorkspacePool } from "@/warmup/pool";

/**
 * The warmup deletion job.
 *
 * It is OFF until a workspace sets settings.warmup.auto_delete_enabled = true —
 * so it is safe to schedule before that switch is flipped; until then it only
 * reports what it *would* delete.
 *
 * THE SAFETY RULE is enforced at the query itself, not just in code around it:
 * every row it touches must have is_warmup = true AND from_email in the pool AND
 * to_email in the pool. The pool is loaded FRESH from the connected-mailbox
 * records every run, so accounts you add or connect later are included
 * automatically, and an address that is not one of your own can never satisfy
 * the filter. On top of that, a pre-flight anomaly check quarantines flagged
 * rows that disagree with the live pool — they are excluded from every deletion
 * pass and logged for review — instead of aborting the whole workspace run, so
 * a few stale or mis-tagged rows can never block cleanup of the genuine
 * warmup set.
 *
 * Volume is unbounded: there is no cap on how many warmups get deleted. Each
 * run drains as much as fits in its time budget, in timeout-safe pages, and the
 * next run continues — so millions of warmups clear over successive ticks
 * without any single statement risking a timeout.
 *
 * Three passes:
 *   1. DB soft-delete — matching rows get deleted_at = now(). Recoverable.
 *   2. DB hard-delete — rows soft-deleted past the grace period are removed.
 *   3. Mailbox trash — the real Gmail/Outlook copies (found by the warmup
 *      header, re-checked against the pool) are MOVED to Trash, never
 *      permanently deleted, so Gmail keeps them recoverable ~30 days.
 */

export interface PurgeOptions {
  workspaceId?: string;
  /** Mailboxes to run the IMAP trash pass over this run (IMAP-bound). */
  mailboxLimit?: number;
  /** Force report-only even when deletion is enabled — for a manual preview. */
  dryRun?: boolean;
  /** Re-purge a mailbox even if it was purged within the last day. */
  ignoreRotation?: boolean;
  now?: Date;
  budgetMs?: number;
}

export interface PurgeResult {
  enabledWorkspaces: number;
  softDeleted: number;
  hardDeleted: number;
  mailboxTrashed: number;
  mailboxesPurged: number;
  aborted: string[];
  skipped: string[];
  /** True when nothing was actually written (disabled everywhere, or dryRun). */
  dryRun: boolean;
}

/** Rows selected/updated per statement — bounded so no single query times out. */
const SELECT_PAGE = 1000;
/** URL length safe: id-lists go in the query string; 1000 uuids ≈ 37 KB. */
const ID_CHUNK = 1000;
/** A mailbox's IMAP folders are re-scanned at most this often. */
const MAILBOX_REPURGE_MS = 20 * 60 * 60 * 1000;
/** Newest N warmup messages a single folder scan returns before it moves them. */
const FOLDER_SCAN_PAGE = 200;

interface WorkspaceConfig {
  autoDeleteEnabled: boolean;
  defaultRule: RetentionRule;
  /** mailbox_id -> per-mailbox retention override (null = inherit). */
  overrides: Map<string, RetentionRule | null>;
}

export async function runWarmupPurge(
  supabase: SupabaseClient,
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 50_000;
  const deadlineAt = startedAt + budgetMs;
  const mailboxLimit = options.mailboxLimit ?? 1;

  const result: PurgeResult = {
    enabledWorkspaces: 0,
    softDeleted: 0,
    hardDeleted: 0,
    mailboxTrashed: 0,
    mailboxesPurged: 0,
    aborted: [],
    skipped: [],
    dryRun: true,
  };

  const pools = await loadWorkspacePools(supabase, options.workspaceId);

  for (const [workspaceId, pool] of pools) {
    if (pool.emails.size < 2) {
      result.skipped.push(`${workspaceId}: fewer than 2 connected accounts`);
      continue;
    }

    const config = await loadWorkspaceConfig(supabase, workspaceId);
    const write = config.autoDeleteEnabled && options.dryRun !== true;
    if (config.autoDeleteEnabled) result.enabledWorkspaces += 1;
    if (write) result.dryRun = false;

    // Pre-flight: quarantine flagged rows that disagree with the live pool so
    // they are excluded from deletion and surfaced for review. The deletion
    // passes below re-assert pool membership at the query level, so quarantined
    // rows can never be touched even if this check hiccups.
    const preflightOk = await quarantineAnomalies(supabase, workspaceId, pool, result);
    if (!preflightOk) continue;

    // Reserve time for the IMAP pass so the DB passes never eat the whole budget.
    const dbDeadline = write ? deadlineAt - 15_000 : deadlineAt;

    await softDeletePass(supabase, workspaceId, pool, config, now, write, dbDeadline, result);
    await hardDeletePass(supabase, workspaceId, pool, now, write, dbDeadline, result);

    if (write && Date.now() + 8_000 < deadlineAt) {
      await mailboxTrashPass(
        supabase,
        workspaceId,
        pool,
        config,
        now,
        mailboxLimit,
        options.ignoreRotation === true,
        deadlineAt,
        result,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------
// Pre-flight anomaly quarantine — the old abort tripwire, defused
// ---------------------------------------------------------------------

/**
 * Counts flagged rows vs flagged rows that also pass the live pool test. Their
 * difference is the number of is_warmup rows whose sender or recipient is NOT
 * one of your own mailboxes — which should be zero (usually leftovers from a
 * mailbox that was disconnected after the warmup ran).
 *
 * The old behavior aborted the entire workspace run when this exceeded a small
 * threshold, which let a handful of stale rows block deletion of the whole
 * genuine warmup set forever. The new behavior quarantines them: they are
 * excluded from every deletion pass (each pass re-asserts pool membership at
 * the query level, so a quarantined row is safe by construction), the external
 * addresses involved are logged to the activity feed for human review, and the
 * run proceeds with the pool-safe set.
 *
 * Returns false only when the flag columns themselves cannot be read (migration
 * 0015 not applied) — in that case there is nothing safe to do.
 */
async function quarantineAnomalies(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
  result: PurgeResult,
): Promise<boolean> {
  const poolArr = [...pool.emails];

  const flagged = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("is_warmup", true)
    .is("deleted_at", null);

  if (flagged.error) {
    // is_warmup / deleted_at absent (migration 0015 not applied): nothing to do.
    result.skipped.push(`${workspaceId}: ${flagged.error.message}`);
    return false;
  }

  const safe = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("is_warmup", true)
    .is("deleted_at", null)
    .in("from_email", poolArr)
    .in("to_email", poolArr);

  const anomalies = (flagged.count ?? 0) - (safe.count ?? 0);
  if (anomalies <= ANOMALY_QUARANTINE_THRESHOLD) return true;

  // Fetch a sample of the offending rows so the activity log shows WHICH
  // external addresses are involved — that is what a human needs to review.
  const { data: sampleRows } = await supabase
    .from("messages")
    .select("from_email,to_email")
    .eq("workspace_id", workspaceId)
    .eq("is_warmup", true)
    .is("deleted_at", null)
    .order("sent_at", { ascending: false })
    .limit(5000);

  const external = new Map<string, number>();
  for (const row of (sampleRows ?? []) as { from_email: string; to_email: string }[]) {
    if (pool.emails.has(row.from_email) && pool.emails.has(row.to_email)) continue;
    for (const addr of [row.from_email, row.to_email]) {
      if (!pool.emails.has(addr)) external.set(addr, (external.get(addr) ?? 0) + 1);
    }
  }
  const topExternal = [...external.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([address, count]) => ({ address, count }));

  result.skipped.push(
    `${workspaceId}: ${anomalies} flagged rows are not warmup by the pool — quarantined (excluded from deletion) for review`,
  );
  await logActivity(supabase, {
    workspaceId,
    action: "warmup.anomalies_quarantined",
    meta: { stage: "preflight", quarantined: anomalies, external_addresses: topExternal },
  });
  return true;
}

// ---------------------------------------------------------------------
// Pass 1 — DB soft delete
// ---------------------------------------------------------------------

async function softDeletePass(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
  config: WorkspaceConfig,
  now: Date,
  write: boolean,
  deadlineAt: number,
  result: PurgeResult,
): Promise<void> {
  const poolArr = [...pool.emails];

  // Group the accounts by their effective retention rule, so one bulk pass runs
  // per rule (usually just the workspace default). resolveRetention picks the
  // per-mailbox override first, then the workspace default, then 7d.
  const sendersByRule = new Map<RetentionRule, string[]>();
  for (const mailbox of pool.mailboxes) {
    const rule = resolveRetention(
      config.overrides.get(mailbox.id) ?? null,
      config.defaultRule,
    );
    const list = sendersByRule.get(rule) ?? [];
    list.push(mailbox.email);
    sendersByRule.set(rule, list);
  }

  for (const [rule, senders] of sendersByRule) {
    if (senders.length === 0) continue;
    const cutoff = retentionCutoff(rule, now).toISOString();

    // A row is eligible iff: flagged, not already soft-deleted, older than the
    // cutoff, sent BY one of these accounts, and TO an address in the pool. The
    // pool membership is in the filter, so a selected row is safe by
    // construction — nothing external can come back from this query.

    if (!write) {
      const { count, error } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("is_warmup", true)
        .is("deleted_at", null)
        .lt("sent_at", cutoff)
        .in("from_email", senders)
        .in("to_email", poolArr);
      if (error) {
        result.skipped.push(`${workspaceId}: soft-delete count failed — ${error.message}`);
        return;
      }
      result.softDeleted += count ?? 0; // "would soft-delete"
      continue;
    }

    let deletedForRule = 0;
    // Drain loop. Each iteration removes up to SELECT_PAGE rows; because
    // deleted_at is set, the next select excludes them, so the loop makes
    // progress with no cursor and stops when nothing eligible remains — or when
    // the time budget runs out, and the next tick resumes exactly here.
    for (;;) {
      if (Date.now() > deadlineAt) {
        result.skipped.push(`${workspaceId}: soft-delete paused on time budget — resumes next tick`);
        break;
      }

      const { data, error } = await supabase
        .from("messages")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("is_warmup", true)
        .is("deleted_at", null)
        .lt("sent_at", cutoff)
        .in("from_email", senders)
        .in("to_email", poolArr)
        .order("sent_at", { ascending: true })
        .limit(SELECT_PAGE);

      if (error) {
        result.skipped.push(`${workspaceId}: soft-delete read failed — ${error.message}`);
        return;
      }
      const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);
      if (ids.length === 0) break;

      const stamp = now.toISOString();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const { error: writeError } = await supabase
          .from("messages")
          .update({ deleted_at: stamp })
          // Re-assert the full safety predicate at write time so a concurrent
          // change can never let a non-warmup or external row slip through.
          .in("id", chunk)
          .eq("is_warmup", true)
          .is("deleted_at", null)
          .in("from_email", senders)
          .in("to_email", poolArr);
        if (writeError) {
          result.skipped.push(`${workspaceId}: soft-delete write failed — ${writeError.message}`);
          return;
        }
        deletedForRule += chunk.length;
        result.softDeleted += chunk.length;
      }

      if (ids.length < SELECT_PAGE) break;
    }

    if (deletedForRule > 0) {
      await logActivity(supabase, {
        workspaceId,
        action: "warmup.soft_deleted",
        meta: { count: deletedForRule, rule, scope: "db_only" },
      });
    }
  }
}

// ---------------------------------------------------------------------
// Pass 2 — DB hard delete (after the grace period)
// ---------------------------------------------------------------------

async function hardDeletePass(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
  now: Date,
  write: boolean,
  deadlineAt: number,
  result: PurgeResult,
): Promise<void> {
  const poolArr = [...pool.emails];
  const graceCutoff = new Date(
    now.getTime() - HARD_DELETE_GRACE_DAYS * 86_400_000,
  ).toISOString();

  // Same pool filter as everywhere else, plus the grace window. A row that no
  // longer looks like warmup by the live pool is simply never selected.
  if (!write) {
    const { count, error } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("is_warmup", true)
      .not("deleted_at", "is", null)
      .lt("deleted_at", graceCutoff)
      .in("from_email", poolArr)
      .in("to_email", poolArr);
    if (error) {
      result.skipped.push(`${workspaceId}: hard-delete count failed — ${error.message}`);
      return;
    }
    result.hardDeleted += count ?? 0; // "would hard-delete"
    return;
  }

  let removed = 0;
  for (;;) {
    if (Date.now() > deadlineAt) {
      result.skipped.push(`${workspaceId}: hard-delete paused on time budget — resumes next tick`);
      break;
    }

    const { data, error } = await supabase
      .from("messages")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_warmup", true)
      .not("deleted_at", "is", null)
      .lt("deleted_at", graceCutoff)
      .in("from_email", poolArr)
      .in("to_email", poolArr)
      .order("deleted_at", { ascending: true })
      .limit(SELECT_PAGE);

    if (error) {
      result.skipped.push(`${workspaceId}: hard-delete read failed — ${error.message}`);
      return;
    }
    const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);
    if (ids.length === 0) break;

    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const { error: delError } = await supabase
        .from("messages")
        .delete()
        .in("id", chunk)
        .eq("is_warmup", true)
        .not("deleted_at", "is", null)
        .in("from_email", poolArr)
        .in("to_email", poolArr);
      if (delError) {
        result.skipped.push(`${workspaceId}: hard-delete failed — ${delError.message}`);
        return;
      }
      removed += chunk.length;
      result.hardDeleted += chunk.length;
    }

    if (ids.length < SELECT_PAGE) break;
  }

  if (removed > 0) {
    await logActivity(supabase, {
      workspaceId,
      action: "warmup.hard_deleted",
      meta: { count: removed, scope: "db_only", grace_days: HARD_DELETE_GRACE_DAYS },
    });
  }
}

// ---------------------------------------------------------------------
// Pass 3 — mailbox (IMAP) move-to-Trash
// ---------------------------------------------------------------------

async function mailboxTrashPass(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
  config: WorkspaceConfig,
  now: Date,
  mailboxLimit: number,
  ignoreRotation: boolean,
  deadlineAt: number,
  result: PurgeResult,
): Promise<void> {
  const due = await mailboxesDue(
    supabase,
    workspaceId,
    pool,
    now,
    mailboxLimit,
    ignoreRotation,
  );

  for (const mailbox of due) {
    if (Date.now() + 5_000 > deadlineAt) break;

    const loaded = await loadMailboxProvider(supabase, mailbox.id);
    if (!loaded) {
      result.skipped.push(`${mailbox.email}: no stored credentials`);
      continue;
    }

    const rule = resolveRetention(
      config.overrides.get(mailbox.id) ?? null,
      config.defaultRule,
    );

    try {
      const trash = await loaded.provider.findTrashFolder();
      if (!trash) {
        result.skipped.push(`${mailbox.email}: no Trash folder found`);
        continue; // do not stamp — retry once the folder is resolvable
      }

      const spam = await loaded.provider.findSpamFolder();
      const sent = await loaded.provider.findSentFolder();
      const folders = ["INBOX", sent, spam].filter(
        (folder): folder is string => Boolean(folder) && folder !== trash,
      );

      let trashedForMailbox = 0;
      let anomalies = 0;

      for (const folder of folders) {
        // Drain the folder: each scan returns the OLDEST FOLDER_SCAN_PAGE warmup
        // messages; moving them to Trash removes them from this folder, so the
        // next scan surfaces the next batch. Stop when a scan moves nothing (all
        // that remain are within retention) or the time budget runs out.
        for (;;) {
          if (Date.now() + 4_000 > deadlineAt) break;

          const refs = await loaded.provider.findByHeaderForPurge(folder, WARMUP_HEADER);
          if (refs.length === 0) break;

          const uids: number[] = [];
          for (const ref of refs) {
            const bothInPool =
              !!ref.fromEmail &&
              !!ref.toEmail &&
              pool.emails.has(ref.fromEmail) &&
              pool.emails.has(ref.toEmail);
            if (!bothInPool) {
              // Carries the warmup header but is not pool-to-pool. Never move it.
              anomalies += 1;
              continue;
            }
            if (!isPastRetention(ref.date, rule, now)) continue;
            uids.push(ref.uid);
          }

          if (uids.length === 0) break; // nothing eligible left in this folder
          const moved = await loaded.provider.moveMessages(folder, uids, trash);
          trashedForMailbox += moved;
          // If the scan window was full and everything eligible was moved, loop
          // to fetch the next window; otherwise we are done with this folder.
          if (refs.length < FOLDER_SCAN_PAGE) break;
        }
      }

      if (anomalies > 0) {
        await logActivity(supabase, {
          workspaceId,
          action: "warmup.purge_anomaly",
          meta: {
            stage: "mailbox",
            mailbox: mailbox.email,
            header_but_external: anomalies,
            note: "warmup-header messages failed the pool re-check; left in place",
          },
        });
      }

      result.mailboxTrashed += trashedForMailbox;
      result.mailboxesPurged += 1;

      // Stamp the rotation clock. Best-effort: if 0015 has not added the column
      // the update simply no-ops and the rotation falls back to table order.
      await supabase
        .from("mailboxes")
        .update({ last_purged_at: now.toISOString() })
        .eq("id", mailbox.id)
        .then(
          () => undefined,
          () => undefined,
        );

      await logActivity(supabase, {
        workspaceId,
        action: "warmup.mailbox_trashed",
        entityType: "mailbox",
        entityId: mailbox.id,
        meta: { mailbox: mailbox.email, count: trashedForMailbox, rule, scope: "db+mailbox" },
      });
    } catch (error) {
      result.skipped.push(
        `${mailbox.email}: trash pass errored — ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await loaded.provider.close().catch(() => undefined);
    }
  }
}

/** Mailboxes due for an IMAP purge — least-recently-purged first, once a day. */
async function mailboxesDue(
  supabase: SupabaseClient,
  workspaceId: string,
  pool: WorkspacePool,
  now: Date,
  limit: number,
  ignoreRotation: boolean,
): Promise<{ id: string; email: string }[]> {
  if (pool.mailboxes.length === 0) return [];

  const ordered = await supabase
    .from("mailboxes")
    .select("id, email, last_purged_at")
    .eq("workspace_id", workspaceId)
    .order("last_purged_at", { ascending: true, nullsFirst: true });

  if (ordered.error || !ordered.data) {
    // Column missing (0015 unapplied) — fall back to arbitrary order.
    return pool.mailboxes.slice(0, limit);
  }

  const rows = ordered.data as {
    id: string;
    email: string;
    last_purged_at: string | null;
  }[];

  const cutoff = now.getTime() - MAILBOX_REPURGE_MS;
  const due = rows.filter((row) => {
    if (ignoreRotation || !row.last_purged_at) return true;
    const at = Date.parse(row.last_purged_at);
    return Number.isNaN(at) || at < cutoff;
  });

  return due.slice(0, limit).map((row) => ({ id: row.id, email: row.email }));
}

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

async function loadWorkspaceConfig(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceConfig> {
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .maybeSingle();

  const settings = readDeletionSettings(
    (workspace as { settings: Record<string, unknown> | null } | null)?.settings,
  );

  const overrides = new Map<string, RetentionRule | null>();
  // delete_after arrives in migration 0015; before it lands this select errors,
  // and every mailbox simply inherits the workspace default.
  const { data: warmupRows, error: overrideError } = await supabase
    .from("warmup_settings")
    .select("mailbox_id, delete_after")
    .eq("workspace_id", workspaceId);

  if (!overrideError) {
    for (const row of (warmupRows ?? []) as {
      mailbox_id: string;
      delete_after: RetentionRule | null;
    }[]) {
      overrides.set(row.mailbox_id, row.delete_after ?? null);
    }
  }

  return {
    autoDeleteEnabled: settings.autoDeleteEnabled,
    defaultRule: settings.deleteAfter,
    overrides,
  };
}
