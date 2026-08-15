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

  if (safeEqual(bearer, secret) || safeEqual(query, secret)) return null;

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
