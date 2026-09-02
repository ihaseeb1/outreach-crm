import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  entity: z.enum(["site", "author"]),
  id: z.string().uuid(),
  status: z.enum(["new", "contacted", "replied", "published", "won"]),
});

/** Updates the relationship-pipeline stage of a discovered site or author. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const table = parsed.data.entity === "site" ? "discovered_sites" : "active_authors";
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from(table)
    .update({ status: parsed.data.status })
    .eq("workspace_id", session.workspace.id)
    .eq("id", parsed.data.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
