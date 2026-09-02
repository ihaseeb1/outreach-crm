import { NextResponse } from "next/server";
import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const KEY = "z7Qw3n8Kx2";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Decode a Bing /ck/a redirect (u=a1<base64url>) to its target URL. */
function decodeBing(href: string): string | null {
  try {
    const u = new URL(href, "https://www.bing.com");
    if (!/bing\.com$/.test(u.hostname)) {
      return u.protocol.startsWith("http") ? u.toString() : null;
    }
    const raw = u.searchParams.get("u");
    if (!raw) return null;
    const b64 = raw.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    return /^https?:\/\//.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== KEY) return NextResponse.json({ error: "no" }, { status: 404 });
  const q = url.searchParams.get("q") ?? 'tech "write for us"';
  const mkt = url.searchParams.get("mkt") ?? "en-AU";

  const started = Date.now();
  const out: Record<string, unknown> = { q };
  try {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&mkt=${mkt}`, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: string[] = [];
    const algoCount = $("li.b_algo").length;
    $("li.b_algo h2 a").each((_, el) => {
      const raw = $(el).attr("href") ?? "";
      const dec = decodeBing(raw);
      if (dec && !results.includes(dec)) results.push(dec);
    });
    out.bing = {
      status: res.status,
      bytes: html.length,
      algoCount,
      count: results.length,
      ms: Date.now() - started,
      sample: results.slice(0, 8),
    };
  } catch (e) {
    out.bing = { error: e instanceof Error ? e.message : String(e) };
  }
  return NextResponse.json(out);
}
