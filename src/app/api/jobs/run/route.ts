import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { runCampaignBatch } from "@/campaigns/run";
import { syncSuppressedCampaignContacts } from "@/campaigns/enroll";
import { runInboundPoll } from "@/mail/poll";
import { runScrapeBatch } from "@/scraper/run";
import { runValidationBatch } from "@/validation/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  job: z.enum(["scrape", "validate", "inbound", "campaigns"]),
  limit: z.number().int().positive().max(200).optional(),
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
      limit: parsed.data.limit ?? 5,
    });
    return NextResponse.json({ ok: true, job: "scrape", ...result });
  }

  if (parsed.data.job === "inbound") {
    const { polled, results } = await runInboundPoll(supabase, {
      workspaceId,
      limit: Math.min(parsed.data.limit ?? 5, 10),
    });
    return NextResponse.json({
      ok: true,
      job: "inbound",
      polled,
      replies: results.reduce((sum, r) => sum + r.replies, 0),
      bounces: results.reduce((sum, r) => sum + r.bounces, 0),
      warmup: results.reduce((sum, r) => sum + r.warmup, 0),
      ignored: results.reduce((sum, r) => sum + r.ignored, 0),
      errors: results.filter((r) => r.error).map((r) => r.error),
    });
  }

  if (parsed.data.job === "campaigns") {
    await syncSuppressedCampaignContacts(supabase, { workspaceId, limit: 200 });
    const result = await runCampaignBatch(supabase, {
      workspaceId,
      limit: Math.min(parsed.data.limit ?? 10, 40),
    });
    return NextResponse.json({ ok: true, job: "campaigns", ...result });
  }

  const result = await runValidationBatch(supabase, {
    workspaceId,
    limit: parsed.data.limit ?? 100,
  });
  return NextResponse.json({ ok: true, job: "validate", ...result });
}
