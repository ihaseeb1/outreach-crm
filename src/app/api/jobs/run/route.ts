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
  limit: z.number().int().positive().max(200).optional(),
  /** Campaigns only: send now even though the clock is outside the window. */
  ignoreWindow: z.boolean().optional(),
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

    // "Check for new replies" means every connected account, not the one that
    // happens to be least recently polled. Someone pressing this button is
    // waiting on a specific reply and has no way to know which mailbox it
    // landed in.
    const { polled, results, deferred } = await runInboundPoll(supabase, {
      workspaceId,
      limit: Math.min(parsed.data.limit ?? 20, 20),
      // Every mailbox at once, in a single round. IMAP is waiting, not working,
      // so eight accounts in parallel take about as long as one — and a second
      // round is what would not fit under the 60s ceiling.
      concurrency: 8,
      budgetMs: rescan > 0 ? 48_000 : 40_000,
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
      rescan,
      ...summarisePoll(results),
    });
  }

  if (parsed.data.job === "campaigns") {
    await syncSuppressedCampaignContacts(supabase, { workspaceId, limit: 200 });
    const result = await runCampaignBatch(supabase, {
      workspaceId,
      limit: Math.min(parsed.data.limit ?? 10, 40),
      // Safe here and only here: this route requires a session, so the
      // override can only ever come from a person pressing a button. The cron
      // routes never pass it.
      ignoreWindow: parsed.data.ignoreWindow,
    });
    return NextResponse.json({ ok: true, job: "campaigns", ...result });
  }

  if (parsed.data.job === "warmup") {
    const result = await runWarmupBatch(supabase, {
      workspaceId,
      sendLimit: Math.min(parsed.data.limit ?? 5, 20),
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
