import { NextResponse } from "next/server";

import { getProviders, runSearch } from "@/discovery/search";
import { getGeoParams } from "@/discovery/geo";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// TEMPORARY diagnostic: confirms whether keyless search works from Vercel's IP.
// Gated by a random key, returns no user data. Removed after verification.
const KEY = "z7Qw3n8Kx2";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) {
    return NextResponse.json({ error: "no" }, { status: 404 });
  }
  const q = url.searchParams.get("q") ?? 'tech "write for us"';
  const geo = getGeoParams(url.searchParams.get("geo") ?? "AU");

  const started = Date.now();
  const results = await runSearch([q], { geo, perQueryLimit: 10, concurrency: 1, perQueryDelayMs: 0 });
  const hits = results[0]?.hits ?? [];

  return NextResponse.json({
    providers: getProviders().map((p) => p.name),
    query: q,
    ms: Date.now() - started,
    count: hits.length,
    sample: hits.slice(0, 5).map((h) => ({ pos: h.position, url: h.url })),
  });
}
