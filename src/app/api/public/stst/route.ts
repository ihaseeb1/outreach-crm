import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// TEMPORARY diagnostic: which keyless search endpoints return results from
// Vercel's IP. Gated, no user data. Removed after verification.
const KEY = "z7Qw3n8Kx2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function probe(name: string, url: string, init: RequestInit) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    const ext = [...body.matchAll(/href="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((h) => !/duckduckgo|bing\.com|microsoft|msn|mojeek|google|gstatic/.test(h));
    return { name, status: res.status, bytes: body.length, extLinks: ext.length, ms: Date.now() - started, sample: ext.slice(0, 3) };
  } catch (e) {
    return { name, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return NextResponse.json({ error: "no" }, { status: 404 });
  const q = url.searchParams.get("q") ?? 'tech "write for us"';
  const enc = encodeURIComponent(q);

  const results = [];
  results.push(await probe("ddg-lite", "https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `q=${enc}`,
  }));
  results.push(await probe("ddg-html", "https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `q=${enc}`,
  }));
  results.push(await probe("bing", `https://www.bing.com/search?q=${enc}&count=20`, {}));
  results.push(await probe("mojeek", `https://www.mojeek.com/search?q=${enc}`, {}));
  results.push(await probe("brave", `https://search.brave.com/search?q=${enc}`, {}));
  results.push(await probe("startpage", `https://www.startpage.com/sp/search?query=${enc}`, {}));

  return NextResponse.json({ q, results });
}
