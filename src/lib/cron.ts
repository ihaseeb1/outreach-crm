import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";

/**
 * Guard for every /api/cron/* route.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Manual runs may also
 * pass `?secret=` for convenience during local testing.
 */
export function assertCronAuthorized(request: Request): NextResponse | null {
  const secret = env.cronSecret();

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = new URL(request.url).searchParams.get("secret") ?? "";

  if (safeEqual(bearer, secret) || safeEqual(query, secret)) {
    // Kill switch. Set CRON_PAUSED=1 in the environment to make every background
    // job a no-op 200 — the scheduler sees success, not a failure, so nothing
    // errors or retries, and warmup/sending resume the instant it is unset. Used
    // during the VM cutover so both environments never process the same work at
    // once. (Applied on the next deploy; the VM worker gets a no-redeploy DB flag.)
    if (process.env.CRON_PAUSED === "1") {
      return NextResponse.json({ ok: true, paused: true }, { status: 200 });
    }
    return null;
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** Standard batch-job result payload. */
export interface JobResult {
  job: string;
  processed: number;
  skipped?: number;
  failed?: number;
  details?: Record<string, unknown>;
}

export function jobResponse(result: JobResult) {
  return NextResponse.json({ ok: true, ...result });
}
