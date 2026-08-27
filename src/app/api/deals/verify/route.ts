import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { dealPlacementReady, verifyDealBacklink } from "@/deals/verify";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({ id: z.string().uuid() });

/**
 * Verify one deal's backlink now (spec §9). Fetches the placed URL and checks
 * the link to the target is live and followable, then stores the verdict.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  if (!(await dealPlacementReady(supabase))) {
    return NextResponse.json(
      { error: "Link verification is not enabled yet — apply migration 0012 in Supabase." },
      { status: 409 },
    );
  }

  const { data: row } = await supabase
    .from("deals")
    .select("id, placed_url, target_url, anchor_text")
    .eq("id", parsed.data.id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Deal not found." }, { status: 404 });
  }

  const result = await verifyDealBacklink(
    supabase,
    row as {
      id: string;
      placed_url: string | null;
      target_url: string | null;
      anchor_text: string | null;
    },
    { workspaceId: session.workspace.id, actorId: session.userId },
  );

  return NextResponse.json({ ok: true, ...result });
}
