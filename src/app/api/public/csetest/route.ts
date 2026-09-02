import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { getProviders, runSearch } from "@/discovery/search";
import { getGeoParams } from "@/discovery/geo";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// TEMPORARY diagnostic to confirm the Google CSE setup works from Vercel.
// Gated by a key; returns no user data. Removed once verified.
const KEY = "z7Qw3n8Kx2";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return NextResponse.json({ error: "no" }, { status: 404 });
  const q = url.searchParams.get("q") ?? 'home improvement "write for us"';

  const out: Record<string, unknown> = {
    engines: env.searchEngines(),
    providers: getProviders().map((p) => p.name),
    cseKeySet: env.googleCseKey().length > 0,
    cseCxSet: env.googleCseCx().length > 0,
  };

  // Raw probe of the Google API so a bad key / quota / disabled-API shows its
  // real error instead of just "0 results".
  if (env.googleCseKey() && env.googleCseCx()) {
    try {
      const g = new URL("https://www.googleapis.com/customsearch/v1");
      g.searchParams.set("key", env.googleCseKey());
      g.searchParams.set("cx", env.googleCseCx());
      g.searchParams.set("q", q);
      g.searchParams.set("num", "5");
      const res = await fetch(g, { signal: AbortSignal.timeout(20000) });
      const body = (await res.json()) as {
        items?: { link?: string }[];
        error?: { message?: string; status?: string };
        searchInformation?: { totalResults?: string };
      };
      out.rawGoogle = {
        status: res.status,
        error: body.error?.message ?? null,
        totalResults: body.searchInformation?.totalResults ?? null,
        sample: (body.items ?? []).slice(0, 5).map((i) => i.link),
      };
    } catch (e) {
      out.rawGoogle = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Through our router (respects SEARCH_ENGINES + geo).
  try {
    const results = await runSearch([q], { geo: getGeoParams("AU"), perQueryLimit: 5, concurrency: 1 });
    out.router = { count: results[0]?.hits.length ?? 0, sample: (results[0]?.hits ?? []).slice(0, 5).map((h) => h.url) };
  } catch (e) {
    out.router = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json(out);
}
