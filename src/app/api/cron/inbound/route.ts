import { assertCronAuthorized, jobResponse } from "@/lib/cron";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runInboundPoll } from "@/mail/poll";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Polls the least-recently-checked mailboxes for new mail. */
export async function GET(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  const limit = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "3",
    10,
  );

  const supabase = createSupabaseAdminClient();
  const { polled, results } = await runInboundPoll(supabase, {
    limit: Number.isFinite(limit) ? Math.min(limit, 10) : 1,
  });

  return jobResponse({
    job: "inbound",
    processed: polled,
    details: {
      replies: results.reduce((sum, r) => sum + r.replies, 0),
      bounces: results.reduce((sum, r) => sum + r.bounces, 0),
      warmup: results.reduce((sum, r) => sum + r.warmup, 0),
      ignored: results.reduce((sum, r) => sum + r.ignored, 0),
      errors: results.filter((r) => r.error).map((r) => r.error),
    },
  });
}

export const POST = GET;
