import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recordWorkerRun } from "@/lib/heartbeat";
import { verifyDueBacklinks } from "@/deals/verify";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Re-verifies live backlinks (spec §9): fetches each placed URL that has not
 * been checked in the last day and confirms the link is still there and still
 * dofollow. Best-effort — no-ops cleanly until migration 0012 adds the columns.
 */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "10",
    10,
  );

  const supabase = createSupabaseAdminClient();

  let tally = { checked: 0, found: 0, missing: 0, errored: 0 };
  try {
    tally = await verifyDueBacklinks(supabase, {
      limit: Number.isFinite(limit) ? Math.min(limit, 30) : 10,
    });
  } catch {
    // Columns not there yet (migration 0012 not applied) — nothing to do.
  }

  await recordWorkerRun(supabase, {
    job: "backlinks",
    ok: true,
    processed: tally.checked,
    failed: tally.errored,
  });

  return jobResponse({
    job: "backlinks",
    processed: tally.checked,
    failed: tally.errored,
    details: { found: tally.found, missing: tally.missing },
  });
}

export const POST = GET;
