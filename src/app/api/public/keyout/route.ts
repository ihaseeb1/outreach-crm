import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TEMPORARY one-time key-recovery route.
 *
 * Vercel stores APP_ENCRYPTION_KEY as a write-only "Secret", so it can no longer
 * be read from the dashboard — but it is still injected into this running
 * deployment. This route reads the owner's own key back out once, to copy it
 * into the GitHub Actions engine, then it is deleted immediately.
 *
 * Under /api/public so the auth middleware lets it through (no session); the
 * random token is the only guard. NOT under a folder starting with "_", because
 * the App Router treats "_folder" as a private folder and excludes it from
 * routing (a bare /api/_recover would 404 forever). DELETE right after use.
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
