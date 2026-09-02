import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { WORLDWIDE } from "@/discovery/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  domains: z.string().min(1).max(200_000),
});

const MAX_SEEDS = 500;

/**
 * Seeds the author crawl directly from pasted publisher domains — so Feature 2
 * can be used without first running a SERP discovery. The seeds are stored as a
 * completed "manual seeds" discovery run whose discovered_sites are opted into
 * author-crawling; the worker takes it from there.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const domains = [
    ...new Set(
      parsed.data.domains
        .split(/[\s,;]+/)
        .map((value) => domainFromUrl(value.trim()))
        .filter(Boolean),
    ),
  ].slice(0, MAX_SEEDS);

  if (domains.length === 0) {
    return NextResponse.json({ error: "No valid domains found." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: run, error: runError } = await supabase
    .from("discovery_runs")
    .insert({
      workspace_id: session.workspace.id,
      created_by: session.userId,
      niche: "Manual publisher seeds",
      geo: WORLDWIDE,
      queries: [],
      status: "completed",
      total_queries: 0,
      processed_queries: 0,
      found_count: domains.length,
      completed_at: new Date().toISOString(),
      settings: { manual_seed: true },
    })
    .select("id")
    .single();

  if (runError || !run) {
    return NextResponse.json(
      { error: runError?.message ?? "Could not create seed run (is migration 0016 applied?)." },
      { status: 500 },
    );
  }

  const runId = (run as { id: string }).id;
  const { error: sitesError } = await supabase.from("discovered_sites").upsert(
    domains.map((domain) => ({
      workspace_id: session.workspace.id,
      run_id: runId,
      root_domain: domain,
      guest_post_url: `https://${domain}`,
      matched_footprint: "manual seed",
      author_crawl: true,
      status: "new",
    })),
    { onConflict: "run_id,root_domain", ignoreDuplicates: true },
  );

  if (sitesError) {
    return NextResponse.json(
      { error: `${sitesError.message} (are migrations 0016/0017 applied?)` },
      { status: 500 },
    );
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "publishers.seeded",
    entityType: "discovery_run",
    entityId: runId,
    meta: { domains: domains.length },
  });

  return NextResponse.json({ ok: true, seeded: domains.length, runId });
}
