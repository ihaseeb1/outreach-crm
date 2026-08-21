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
    new URL(request.url).searchParams.get("limit") ?? "12",
    10,
  );

  const supabase = createSupabaseAdminClient();
  // Six at a time inside a 40s budget: comfortably under the 60s function
  // ceiling even if every mailbox is slow, and a whole workspace gets covered
  // in a tick rather than one mailbox per tick.
  //
  // Paused mailboxes are polled as well. Pausing stops a mailbox *sending*; the
  // replies to what it already sent still arrive, and dropping them on the
  // floor because of a toggle that means something else would lose real mail.
  const { polled, results, deferred, queued, unpollable } = await runInboundPoll(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 50) : 12,
    concurrency: 6,
    budgetMs: 40_000,
    includeInactive: true,
  });

  return jobResponse({
    job: "inbound",
    processed: polled,
    details: { deferred, queued, unpollable, ...summarisePoll(results) },
  });
}

export const POST = GET;
