import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCampaignBatch } from "@/campaigns/run";
import { syncSuppressedCampaignContacts } from "@/campaigns/enroll";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Sends the next due sequence step for a batch of campaign contacts. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "10",
    10,
  );

  const supabase = createSupabaseAdminClient();

  // Clear out anything that has been suppressed since it was queued, then send.
  const { stopped } = await syncSuppressedCampaignContacts(supabase, { limit: 200 });
  const result = await runCampaignBatch(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 40) : 10,
  });

  return jobResponse({
    job: "campaigns",
    processed: result.sent,
    skipped: result.skipped,
    failed: result.failed,
    details: {
      completed: result.completed,
      stopped: result.stopped,
      suppressedRemoved: stopped,
      notes: result.notes,
    },
  });
}

export const POST = GET;
