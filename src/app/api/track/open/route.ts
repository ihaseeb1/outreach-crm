import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyOpen } from "@/mail/tracking";
import { recordEvent } from "@/mail/tracking-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tracking pixel.
 *
 * Public and unauthenticated — it is fetched by the recipient's mail client, so
 * there is no session to read. The HMAC in `s` is what authorises the write,
 * and the admin client is used because the caller has no rights of their own.
 *
 * It always returns the image, whatever happened to the recording. An email
 * that shows a broken image because a database write failed is a worse outcome
 * than a missed count.
 */

const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function image() {
  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
      // Gmail proxies and caches images. Without this the second open of the
      // same email can be served from the proxy and never reach us; it does not
      // make counting exact, but it stops the cache guaranteeing an undercount.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      pragma: "no-cache",
    },
  });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const messageId = params.get("m");
  const provided = params.get("s");

  if (!messageId || !provided || !verifyOpen(messageId, provided)) return image();

  try {
    const supabase = createSupabaseAdminClient();
    const { data } = await supabase
      .from("messages")
      .select("id, meta")
      .eq("id", messageId)
      .maybeSingle();

    const row = data as { id: string; meta: Record<string, unknown> | null } | null;
    if (row) {
      await supabase
        .from("messages")
        .update({
          meta: recordEvent(row.meta, "open", new Date().toISOString()),
        })
        .eq("id", row.id);
    }
  } catch {
    // Deliberately silent: see above.
  }

  return image();
}
