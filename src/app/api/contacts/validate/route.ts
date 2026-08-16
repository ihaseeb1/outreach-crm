import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { validateContacts } from "@/validation/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // Capped well below what 60s of MX lookups can finish, so the request
  // returns a real answer rather than being cut off mid-batch.
  ids: z.array(z.string().uuid()).min(1).max(100),
  /** Re-check contacts that already have a verdict. */
  force: z.boolean().optional(),
});

/** Validates specific contacts on demand from the Contacts screen. */
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

  // Admin client for the DNS-driven write, scoped by hand to this workspace —
  // validateContacts filters on workspace_id, and the ids are checked against
  // it too, so a foreign id simply matches nothing.
  const supabase = createSupabaseAdminClient();

  const result = await validateContacts(supabase, {
    workspaceId: session.workspace.id,
    ids: parsed.data.ids,
    force: parsed.data.force,
  });

  return NextResponse.json({ ok: true, ...result });
}
