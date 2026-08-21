import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decodeClickTarget, verifyClick } from "@/mail/tracking";
import { recordEvent } from "@/mail/tracking-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Click-through: record it, then send them where they were going.
 *
 * The destination is signed together with the message id, so this cannot be
 * turned into an open redirect on the CRM's own domain — an unsigned `?u=` here
 * would be worth more to a phisher than the tracking is worth to us. An
 * unverifiable link falls back to the home page rather than following the URL
 * it was handed.
 *
 * The redirect happens even if the recording fails. A publisher clicking a link
 * in a quote and landing on an error page is a real cost; a lost count is not.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const messageId = params.get("m");
  const encoded = params.get("u");
  const provided = params.get("s");

  const target = encoded ? decodeClickTarget(encoded) : null;

  if (!messageId || !target || !provided || !verifyClick(messageId, target, provided)) {
    return NextResponse.redirect(new URL("/", url.origin), 302);
  }

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
          meta: recordEvent(row.meta, "click", new Date().toISOString(), target),
        })
        .eq("id", row.id);
    }
  } catch {
    // Silent on purpose — the redirect below is what matters.
  }

  return NextResponse.redirect(target, 302);
}
