import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { suppressEmail } from "@/mail/suppressions";
import { escapeHtml, verifyUnsubscribeParams } from "@/mail/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe. No login, no confirmation step, no second page —
 * the address is suppressed the moment this endpoint is hit, and is never
 * emailed again by any campaign or by warmup.
 *
 * POST implements RFC 8058 one-click (Gmail/Outlook's native unsubscribe
 * button); GET serves the link in the email footer.
 */

async function unsubscribe(request: Request): Promise<{ ok: boolean; email?: string }> {
  const params = new URL(request.url).searchParams;
  const token = verifyUnsubscribeParams(params);
  if (!token) return { ok: false };

  const supabase = createSupabaseAdminClient();

  await suppressEmail(supabase, {
    workspaceId: token.workspaceId,
    email: token.email,
    reason: "unsubscribed",
    source: "one_click_unsubscribe",
  });

  // Stop anything already in flight for this contact.
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("workspace_id", token.workspaceId)
    .eq("email", token.email)
    .limit(1)
    .maybeSingle();

  if (contact) {
    await supabase
      .from("campaign_contacts")
      .update({
        status: "unsubscribed",
        next_send_at: null,
        paused_reason: "Unsubscribed",
      })
      .eq("workspace_id", token.workspaceId)
      .eq("contact_id", (contact as { id: string }).id)
      .in("status", ["pending", "active"]);
  }

  return { ok: true, email: token.email };
}

export async function GET(request: Request) {
  const result = await unsubscribe(request);
  return new NextResponse(page(result.ok, result.email), {
    status: result.ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const result = await unsubscribe(request);
  return NextResponse.json(
    result.ok ? { ok: true } : { error: "Invalid or expired link." },
    { status: result.ok ? 200 : 400 },
  );
}

function page(ok: boolean, email?: string): string {
  const body = ok
    ? `<h1>You're unsubscribed</h1>
       <p><strong>${escapeHtml(email ?? "")}</strong> has been removed and will not
       receive any further emails from us.</p>
       <p class="muted">This took effect immediately. No further action is needed.</p>`
    : `<h1>Link not valid</h1>
       <p>This unsubscribe link is invalid or has been altered.</p>
       <p class="muted">Reply to the email you received and we'll remove you manually.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${ok ? "Unsubscribed" : "Link not valid"}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #f6f7f9; color: #14181f; padding: 24px;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    }
    .card {
      max-width: 32rem; background: #fff; border: 1px solid #e3e6ea;
      border-radius: 12px; padding: 32px;
    }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { margin: 0 0 12px; line-height: 1.55; font-size: 0.95rem; }
    .muted { color: #5c6675; font-size: 0.85rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #14181f; color: #f6f7f9; }
      .card { background: #1c222b; border-color: #2c333e; }
      .muted { color: #9aa4b2; }
    }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}
