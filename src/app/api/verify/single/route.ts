import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { verifyEmail } from "@/validation/verify-engine";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().min(3).max(320),
  mode: z.enum(["quick", "power"]).optional(),
});

/**
 * Verifies a single address on demand — the search box on the Verify page.
 *
 * Power mode opens a real SMTP conversation, which needs outbound port 25. The
 * deployed app cannot do that (Vercel blocks it), so a power request from the
 * dashboard falls back to a quick-plus-indeterminate result rather than failing;
 * the deep mailbox check for your actual list is run by the verify worker.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const mode = parsed.data.mode ?? "quick";
  let mailFrom: string | undefined;
  if (mode === "power") {
    const supabase = createSupabaseAdminClient();
    const { data } = await supabase
      .from("mailboxes")
      .select("email")
      .eq("workspace_id", session.workspace.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    mailFrom = (data as { email: string } | null)?.email ?? undefined;
  }

  const result = await verifyEmail(parsed.data.email, { mode, mailFrom });
  return NextResponse.json({ ok: true, result });
}
