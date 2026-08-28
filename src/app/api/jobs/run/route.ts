import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { runCampaignBatch } from "@/campaigns/run";
import { syncSuppressedCampaignContacts } from "@/campaigns/enroll";
import { runHealthChecks } from "@/health/run";
import { runInboundPoll, summarisePoll } from "@/mail/poll";
import { runScrapeBatch } from "@/scraper/run";
import { runWarmupBatch } from "@/warmup/engine";
import { runValidationBatch } from "@/validation/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  job: z.enum(["scrape", "validate", "inbound", "campaigns", "warmup", "health"]),
  // Optional for inbound and it means "no cap" when omitted, which is the
  // normal case: a manual poll covers every mailbox however many there are.
  limit: z.number().int().positive().max(1000).optional(),
  /** Campaigns only: send now even though the clock is outside the window. */
  ignoreWindow: z.boolean().optional(),
  /** Campaigns only: restrict the run to one campaign. */
  campaignId: z.string().uuid().optional(),
  /**
   * Campaigns only: before sending, un-stick contacts whose sequence stalled —
   * reactivate any `failed` enrolment (that has not replied / bounced / opted
   * out) and make every overdue step due now, then send ignoring the window.
   * This is the "my follow-ups got stuck, push them" button.
   */
  release: z.boolean().optional(),
  /** Inbound only: re-read this many UIDs below each mailbox's checkpoint. */
  rescan: z.number().int().min(0).max(500).optional(),
});

/**
 * "Run now" from the UI. Same batch functions the cron uses, but scoped to the
 * caller's workspace so a manual run can never touch someone else's data.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const workspaceId = session.workspace.id;

  if (parsed.data.job === "scrape") {
    const result = await runScrapeBatch(supabase, {
      workspaceId,
      limit: parsed.data.limit ?? 10,
    });
    return NextResponse.json({ ok: true, job: "scrape", ...result });
  }

  if (parsed.data.job === "inbound") {
    const rescan = parsed.data.rescan ?? 0;

    // "Poll mailboxes now" means every connected account, without a cap.
    //
    // It used to take the least-recently-polled twenty, and skip anything
    // switched off for sending. On a seven-mailbox workspace with two of them
    // paused that reported "Checked 5 of 5" — a sentence with no way to tell
    // that two accounts had been left out entirely. Someone pressing this
    // button is waiting on a specific reply and has no idea which mailbox it
    // landed in, so the answer has to cover all of them.
    const { polled, results, deferred, queued, unpollable } = await runInboundPoll(supabase, {
      workspaceId,
      limit: parsed.data.limit,
      includeInactive: true,
      // Every mailbox at once, in a single round. IMAP is waiting, not working,
      // so eight accounts in parallel take about as long as one. Anything past
      // that is queued by the workers and picked up as slots free.
      concurrency: 8,
      budgetMs: rescan > 0 ? 48_000 : 42_000,
      // A rescan reads far more per mailbox, so it gets a longer leash each and
      // still only one round.
      mailboxTimeoutMs: rescan > 0 ? 40_000 : 25_000,
      rescanUids: rescan,
      // It walks back over mail that is already stored, so it needs a deeper
      // fetch to reach anything new sitting behind it.
      fetchLimit: rescan > 0 ? Math.min(rescan, 60) : undefined,
    });

    return NextResponse.json({
      ok: true,
      job: "inbound",
      polled,
      deferred,
      queued,
      unpollable,
      rescan,
      ...summarisePoll(results),
    });
  }

  if (parsed.data.job === "campaigns") {
    await syncSuppressedCampaignContacts(supabase, { workspaceId, limit: 200 });

    // "Push stuck follow-ups": revive enrolments that stalled and make every
    // overdue step due right now. Only `failed` rows are revived, and never one
    // that has already replied / bounced / opted out — those stopped for real
    // reasons. It also clears expired claim locks and pulls any past-due
    // next_send_at up to now, so a follow-up that missed its window goes on the
    // next send instead of waiting.
    let reactivated = 0;
    if (parsed.data.release) {
      const nowIso = new Date().toISOString();
      const campaignId = parsed.data.campaignId;

      let revive = supabase
        .from("campaign_contacts")
        .update({
          status: "active",
          next_send_at: nowIso,
          attempts: 0,
          locked_until: null,
          last_error: null,
          paused_reason: null,
        })
        .eq("workspace_id", workspaceId)
        .eq("status", "failed");
      if (campaignId) revive = revive.eq("campaign_id", campaignId);
      const { data: revived } = await revive.select("id");
      reactivated = (revived ?? []).length;

      // Release expired claim locks on live rows so nothing is stuck behind a
      // lock from a run that died mid-send.
      let unlock = supabase
        .from("campaign_contacts")
        .update({ locked_until: null })
        .eq("workspace_id", workspaceId)
        .in("status", ["pending", "active"])
        .not("locked_until", "is", null)
        .lt("locked_until", nowIso);
      if (campaignId) unlock = unlock.eq("campaign_id", campaignId);
      await unlock;
    }

    const result = await runCampaignBatch(supabase, {
      workspaceId,
      campaignId: parsed.data.campaignId,
      limit: Math.min(parsed.data.limit ?? 10, 40),
      // Safe here and only here: this route requires a session, so the
      // override can only ever come from a person pressing a button. The cron
      // routes never pass it. A "release" push always ignores the window.
      ignoreWindow: parsed.data.ignoreWindow || parsed.data.release,
    });
    return NextResponse.json({ ok: true, job: "campaigns", reactivated, ...result });
  }

  if (parsed.data.job === "warmup") {
    // Bounded by the engine's own time guard, so a manual run does as many as it
    // safely can and defers the rest — it never bursts a single mailbox.
    const result = await runWarmupBatch(supabase, {
      workspaceId,
      sendLimit: Math.min(parsed.data.limit ?? 40, 40),
    });
    return NextResponse.json({ ok: true, job: "warmup", ...result });
  }

  if (parsed.data.job === "health") {
    const result = await runHealthChecks(supabase, {
      workspaceId,
      limit: Math.min(parsed.data.limit ?? 10, 20),
    });
    return NextResponse.json({ ok: true, job: "health", ...result });
  }

  const result = await runValidationBatch(supabase, {
    workspaceId,
    limit: parsed.data.limit ?? 100,
  });
  return NextResponse.json({ ok: true, job: "validate", ...result });
}
