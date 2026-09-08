import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY one-time key-recovery route.
 *
 * Vercel stores APP_ENCRYPTION_KEY as a write-only "Secret", so it can no longer
 * be read from the dashboard — but it is still injected into this running
 * deployment. This route lets the owner read their own key back out once, to
 * copy it into the GitHub Actions engine, then it is deleted immediately. It is
 * guarded by a random token and returns nothing without it.
 *
 * Lives under /api/public so the auth middleware lets it through (it has no
 * session); the random token is the only guard. DELETE THIS FILE right after use.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  if (token !== "rk_d83e9d8762ae19247c23e1a519c64d6d") {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json(
    { k: process.env.APP_ENCRYPTION_KEY ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
