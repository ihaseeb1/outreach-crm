import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runInboundPoll, summarisePoll } from "@/mail/poll";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Polls the least-recently-checked mailboxes for new mail. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "8",
    10,
  );

  const supabase = createSupabaseAdminClient();
  // Four at a time inside a 45s budget: comfortably under the 60s function
  // ceiling even if every mailbox is slow, and a whole workspace gets covered
  // in a tick or two rather than one mailbox per tick.
  const { polled, results, deferred } = await runInboundPoll(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 20) : 8,
    concurrency: 4,
    budgetMs: 40_000,
  });

  return jobResponse({
    job: "inbound",
    processed: polled,
    details: { deferred, ...summarisePoll(results) },
  });
}

export const POST = GET;
