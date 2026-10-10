/**
 * Daily CRM integrity check — READ ONLY.
 *
 * Verifies three things the business depends on every day:
 *   1. Stuck replies — contacts with a recorded inbound reply (or a send that
 *      went out AFTER a reply) whose campaign_contacts row is still
 *      active/pending instead of replied. This is the exact failure class of
 *      the 2026-09-30 reply-stop bug; the check exists so it can never recur
 *      silently.
 *   2. Mailbox health — mailboxes not in `healthy` status, plus today's
 *      mailbox_health rows carrying warnings/issues.
 *   3. Send windows — campaigns whose send window drifted off the 1→24
 *      (1 AM–midnight) standard, and mailboxes whose inter-send gaps drifted
 *      off the 2400s/2760s (40–46 min) inter-send gap standard
 *      (owner decision 2026-10-09: 30/day, 40–46 min gaps; migration 0024's 300s/720s superseded).
 *
 * Writes NOTHING to business tables. The only write is the standard worker
 * heartbeat row (recordWorkerRun, job "integrity") so runs are auditable.
 *
 * Output: prints the JSON summary to stdout and writes integrity-summary.json
 * (picked up as a CI artifact by .github/workflows/integrity-check.yml).
 * Exit code is always 0 — findings are data, not failures.
 *
 * Env (from GitHub Secrets): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { writeFileSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { recordWorkerRun } from "../src/lib/heartbeat";

// Pick up .env.local for local testing; in Actions the env comes from secrets.
try {
  (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(
    ".env.local",
  );
} catch {
  // No .env.local — rely on the ambient environment.
}

type Severity = "critical" | "warning";

// Bounce/DSN senders whose transient notices are stored with is_bounce=false
// for the audit trail only (delay DSNs / soft bounces are not real bounces
// and are never replies). Keep them out of the "missed reply" check.
const DSN_SENDER_PARTS = [
  "mailer-daemon",
  "postmaster",
  "mail-delivery",
  "maildeliverysystem",
  "no-reply-delivery",
];

function isDsnSender(fromEmail: unknown): boolean {
  const local = (String(fromEmail ?? "").split("@")[0] ?? "").toLowerCase();
  return DSN_SENDER_PARTS.some((s) => local.includes(s));
}

interface Issue {
  check: "stuck_replies" | "mailbox_health" | "send_windows";
  severity: Severity;
  title: string;
  count: number;
  sample: Record<string, unknown>[];
}

const EXPECTED_WINDOW = { start: 1, end: 24 };
// Owner-decided mailbox standard (2026-10-09): 30/day, 40–46 min gaps.
const EXPECTED_GAP = { min: 2400, max: 2760 };

function summarize(rows: Record<string, unknown>[], fields: string[]) {
  return rows.slice(0, 10).map((r) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = r[f] ?? null;
    return out;
  });
}

async function checkStuckReplies(
  supabase: SupabaseClient,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const active = ["active", "pending"];

  // 1a. Reply recorded but the contact row never flipped to `replied`.
  const { data: unflipped, error: e1 } = await supabase
    .from("campaign_contacts")
    .select("id,campaign_id,contact_id,status,replied_at,last_sent_at,updated_at")
    .in("status", active)
    .not("replied_at", "is", null)
    .order("replied_at", { ascending: false })
    .limit(100);
  if (e1) throw new Error(`stuck_replies/unflipped: ${e1.message}`);
  if ((unflipped ?? []).length > 0) {
    issues.push({
      check: "stuck_replies",
      severity: "critical",
      title: "Reply recorded but contact still active/pending (status never flipped to replied)",
      count: (unflipped ?? []).length,
      sample: summarize(
        (unflipped ?? []) as Record<string, unknown>[],
        ["id", "campaign_id", "contact_id", "status", "replied_at", "last_sent_at"],
      ),
    });
  }

  // 1b. A send went out AFTER a reply was recorded — the Sep-30 bug recurring.
  const { data: sentAfter, error: e2 } = await supabase
    .from("campaign_contacts")
    .select("id,campaign_id,contact_id,status,replied_at,last_sent_at")
    .in("status", active)
    .not("replied_at", "is", null)
    .not("last_sent_at", "is", null)
    .order("last_sent_at", { ascending: false })
    .limit(100);
  if (e2) throw new Error(`stuck_replies/sent-after-reply: ${e2.message}`);
  const sentAfterReply = ((sentAfter ?? []) as Record<string, unknown>[]).filter(
    (r) =>
      r.replied_at &&
      r.last_sent_at &&
      new Date(r.last_sent_at as string) > new Date(r.replied_at as string),
  );
  if (sentAfterReply.length > 0) {
    issues.push({
      check: "stuck_replies",
      severity: "critical",
      title: "Send went out AFTER a reply was recorded (reply-stop failure)",
      count: sentAfterReply.length,
      sample: summarize(sentAfterReply, [
        "id",
        "campaign_id",
        "contact_id",
        "status",
        "replied_at",
        "last_sent_at",
      ]),
    });
  }

  // 1c. Inbound mail in the last 24h whose contact is still active/pending —
  // replies the engine may have missed entirely.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: inbound, error: e3 } = await supabase
    .from("messages")
    .select("id,contact_id,from_email,received_at,subject")
    .eq("direction", "inbound")
    .eq("status", "received")
    .eq("is_auto_reply", false)
    .eq("is_bounce", false)
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(200);
  if (e3) throw new Error(`stuck_replies/inbound-24h: ${e3.message}`);
  const contactIds = [
    ...new Set(
      ((inbound ?? []) as Record<string, unknown>[])
        .map((m) => m.contact_id)
        .filter(Boolean),
    ),
  ];
  let missed: Record<string, unknown>[] = [];
  if (contactIds.length > 0) {
    const { data: stillActive, error: e4 } = await supabase
      .from("campaign_contacts")
      .select("id,campaign_id,contact_id,status,replied_at,last_sent_at")
      .in("contact_id", contactIds as string[])
      .in("status", active)
      .limit(200);
    if (e4) throw new Error(`stuck_replies/missed: ${e4.message}`);
    const inboundByContact = new Map<string, Record<string, unknown>>();
    for (const m of (inbound ?? []) as Record<string, unknown>[]) {
      inboundByContact.set(m.contact_id as string, m);
    }
    missed = ((stillActive ?? []) as Record<string, unknown>[])
      .filter((cc) => {
        const msg = inboundByContact.get(cc.contact_id as string);
        // Flag only when the reply predates any recorded replied_at (i.e. the
        // engine saw the mail but never flipped the row).
        return !cc.replied_at && msg;
      })
      .map((cc) => ({
        ...cc,
        inbound_received_at: (inboundByContact.get(
          cc.contact_id as string,
        ) as Record<string, unknown> | undefined)?.received_at,
        inbound_from: (inboundByContact.get(
          cc.contact_id as string,
        ) as Record<string, unknown> | undefined)?.from_email,
      }))
      // Drop transient DSN notices stored with is_bounce=false — the bounce
      // pipeline already handled them, and they are not missed replies.
      .filter((m) => !isDsnSender(m.inbound_from));
  }
  if (missed.length > 0) {
    issues.push({
      check: "stuck_replies",
      severity: "critical",
      title:
        "Inbound reply in the last 24h with contact still active/pending (engine missed the reply)",
      count: missed.length,
      sample: summarize(missed, [
        "id",
        "campaign_id",
        "contact_id",
        "status",
        "inbound_from",
        "inbound_received_at",
      ]),
    });
  }

  return issues;
}

async function checkMailboxHealth(
  supabase: SupabaseClient,
): Promise<Issue[]> {
  const issues: Issue[] = [];

  const { data: bad, error: e1 } = await supabase
    .from("mailboxes")
    .select("id,email,health_status,paused_reason,last_error,last_send_at")
    .neq("health_status", "healthy")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (e1) throw new Error(`mailbox_health/status: ${e1.message}`);
  if ((bad ?? []).length > 0) {
    const rows = (bad ?? []) as Record<string, unknown>[];
    const paused = rows.filter((r) => r.health_status === "paused");
    issues.push({
      check: "mailbox_health",
      severity: paused.length > 0 ? "critical" : "warning",
      title: `Mailboxes not healthy (${paused.length} paused, ${
        rows.length - paused.length
      } warning)`,
      count: rows.length,
      sample: summarize(rows, [
        "email",
        "health_status",
        "paused_reason",
        "last_error",
      ]),
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: rows, error: e2 } = await supabase
    .from("mailbox_health")
    .select("mailbox_id,status,issues,reputation_score,checked_at")
    .eq("date", today)
    .neq("status", "healthy")
    .order("checked_at", { ascending: false })
    .limit(50);
  if (e2) throw new Error(`mailbox_health/today: ${e2.message}`);
  const flagged = ((rows ?? []) as Record<string, unknown>[]).filter(
    (r) =>
      r.status !== "healthy" ||
      (Array.isArray(r.issues) && (r.issues as unknown[]).length > 0),
  );
  if (flagged.length > 0) {
    issues.push({
      check: "mailbox_health",
      severity: "warning",
      title: "Today's health rows with warnings/issues",
      count: flagged.length,
      sample: summarize(flagged, [
        "mailbox_id",
        "status",
        "issues",
        "reputation_score",
      ]),
    });
  }

  return issues;
}

async function checkSendWindows(
  supabase: SupabaseClient,
): Promise<Issue[]> {
  const issues: Issue[] = [];

  const { data: campaigns, error: e1 } = await supabase
    .from("campaigns")
    .select("id,name,status,settings")
    .eq("status", "active")
    .limit(100);
  if (e1) throw new Error(`send_windows/campaigns: ${e1.message}`);
  const drifted = ((campaigns ?? []) as Record<string, unknown>[]).filter(
    (c) => {
      const s = (c.settings ?? {}) as Record<string, unknown>;
      return (
        s.send_window_start !== EXPECTED_WINDOW.start ||
        s.send_window_end !== EXPECTED_WINDOW.end
      );
    },
  );
  if (drifted.length > 0) {
    issues.push({
      check: "send_windows",
      severity: "warning",
      title: `Active campaigns off the 1→24 (1 AM–midnight) send window`,
      count: drifted.length,
      sample: summarize(drifted, ["id", "name", "status", "settings"]),
    });
  }

  const { data: mailboxes, error: e2 } = await supabase
    .from("mailboxes")
    .select("id,email,is_active,min_gap_seconds,max_gap_seconds,daily_limit")
    .eq("is_active", true)
    .limit(100);
  if (e2) throw new Error(`send_windows/mailboxes: ${e2.message}`);
  const gapDrift = ((mailboxes ?? []) as Record<string, unknown>[]).filter(
    (m) =>
      m.min_gap_seconds !== EXPECTED_GAP.min ||
      m.max_gap_seconds !== EXPECTED_GAP.max,
  );
  if (gapDrift.length > 0) {
    issues.push({
      check: "send_windows",
      severity: "warning",
      title: `Active mailboxes off the 2400s/2760s (40–46 min) inter-send gap standard`,
      count: gapDrift.length,
      sample: summarize(gapDrift, [
        "email",
        "min_gap_seconds",
        "max_gap_seconds",
        "daily_limit",
      ]),
    });
  }

  return issues;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    console.error(
      "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.",
    );
    process.exit(1);
  }

  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const checkedAt = new Date().toISOString();
  const issues: Issue[] = [
    ...(await checkStuckReplies(supabase)),
    ...(await checkMailboxHealth(supabase)),
    ...(await checkSendWindows(supabase)),
  ];

  const summary = {
    checked_at: checkedAt,
    ok: issues.length === 0,
    issue_count: issues.length,
    critical_count: issues.filter((i) => i.severity === "critical").length,
    issues,
  };

  writeFileSync("integrity-summary.json", JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  await recordWorkerRun(supabase, {
    job: "integrity",
    ok: true,
    processed: issues.length,
  });

  console.log("integrity-check done.");
}

void main();
