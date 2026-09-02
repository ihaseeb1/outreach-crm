import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { expandFootprints } from "@/discovery/footprints";
import { WORLDWIDE, isCountryCode } from "@/discovery/geo";
import { runDiscoveryRunById } from "@/discovery/run";
import { cloudSearchViable } from "@/discovery/search";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * How many queries to run inline (synchronously) so results come back within a
 * single request. DDG throttles, so each query is spaced ~2.5s; ~16 queries
 * fits comfortably under the 60s budget. Anything beyond this the background
 * worker/cron picks up.
 */
const INLINE_QUERY_CAP = 16;

const createSchema = z.object({
  niche: z.string().min(1).max(200),
  geo: z.string().max(20).default(WORLDWIDE),
  includeSynonyms: z.boolean().default(true),
  /** Optional custom footprint templates (Phase 6 editor). */
  templates: z.array(z.string().min(1).max(300)).max(100).optional(),
  /** Optional edited/expanded query list — overrides footprint expansion. */
  queries: z.array(z.string().min(1).max(300)).max(2000).optional(),
  extraNiches: z.array(z.string().min(1).max(200)).max(50).optional(),
});

/** Creates a discovery run (status pending); the worker/cron executes it. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { niche, includeSynonyms, templates, extraNiches } = parsed.data;
  const geo = parsed.data.geo === WORLDWIDE || isCountryCode(parsed.data.geo)
    ? parsed.data.geo.toUpperCase()
    : WORLDWIDE;

  // An operator can hand an edited query list straight through; otherwise
  // expand footprints × niche synonyms. Either way, enforce the cost guard,
  // then cap to what fits one inline request so results come back live.
  const cap = Math.min(env.maxSearchQueriesPerRun(), INLINE_QUERY_CAP);
  const queries = (
    parsed.data.queries && parsed.data.queries.length > 0
      ? dedupe(parsed.data.queries)
      : expandFootprints(niche, { includeSynonyms, templates, extraNiches })
  ).slice(0, cap);

  if (queries.length === 0) {
    return NextResponse.json({ error: "No queries to run." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("discovery_runs")
    .insert({
      workspace_id: session.workspace.id,
      created_by: session.userId,
      niche,
      geo,
      queries,
      status: "pending",
      total_queries: queries.length,
      settings: { includeSynonyms, custom_templates: Boolean(templates?.length) },
    })
    .select("id")
    .single();

  if (error || !data) {
    // Most likely migration 0016 not applied yet — say so plainly.
    return NextResponse.json(
      { error: error?.message ?? "Could not create run (is migration 0016 applied?)." },
      { status: 500 },
    );
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "discovery.run_created",
    entityType: "discovery_run",
    entityId: data.id,
    meta: { niche, geo, queries: queries.length },
  });

  // Execute inline so results are there on page load — but only when a
  // cloud-capable engine (Google CSE / SearXNG) is configured. With only
  // keyless engines (DuckDuckGo/Bing), search is blocked from Vercel's IP, so
  // we leave the run pending for the local worker rather than "completing" it
  // with zero results.
  let found = 0;
  const deferred = !cloudSearchViable();
  if (!deferred) {
    try {
      found = await runDiscoveryRunById(supabase, data.id as string);
    } catch {
      // Left running; the worker/cron finishes it. The page keeps updating.
    }
  }

  return NextResponse.json({
    ok: true,
    runId: data.id,
    queries: queries.length,
    found,
    deferred,
  });
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
