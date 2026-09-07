import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { logActivity } from "@/lib/activity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { expandLeadQueries } from "@/leads/footprints";
import { WORLDWIDE, isCountryCode } from "@/discovery/geo";
import { runLeadRunById } from "@/leads/run";
import { cloudSearchViable } from "@/discovery/search";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Queries to run inline (cloud engines only) so results come back live. */
const INLINE_QUERY_CAP = 16;

const createSchema = z.object({
  industry: z.string().min(1).max(200),
  location: z.string().max(200).optional(),
  geo: z.string().max(20).default(WORLDWIDE),
  extraIndustries: z.array(z.string().min(1).max(200)).max(50).optional(),
  /** Optional edited query list — overrides expansion. */
  queries: z.array(z.string().min(1).max(300)).max(2000).optional(),
});

/** Creates a lead-sourcing run (status pending); the worker/cron executes it. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { industry, location, extraIndustries } = parsed.data;
  const geo =
    parsed.data.geo === WORLDWIDE || isCountryCode(parsed.data.geo)
      ? parsed.data.geo.toUpperCase()
      : WORLDWIDE;

  // Keyless runs defer to the worker (no time budget) so store the full query
  // list; cloud-viable runs execute inline in this request so clamp to fit 60s.
  const runsInline = cloudSearchViable();
  const cap = runsInline
    ? Math.min(env.maxSearchQueriesPerRun(), INLINE_QUERY_CAP)
    : env.maxSearchQueriesPerRun();
  const queries = (
    parsed.data.queries && parsed.data.queries.length > 0
      ? dedupe(parsed.data.queries)
      : expandLeadQueries(industry, location, { extraIndustries })
  ).slice(0, cap);

  if (queries.length === 0) {
    return NextResponse.json({ error: "No queries to run." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("lead_runs")
    .insert({
      workspace_id: session.workspace.id,
      created_by: session.userId,
      industry,
      location: location ?? null,
      geo,
      queries,
      status: "pending",
      total_queries: queries.length,
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create run (is migration 0021 applied?)." },
      { status: 500 },
    );
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "leads.run_created",
    entityType: "lead_run",
    entityId: data.id,
    meta: { industry, location: location ?? null, geo, queries: queries.length },
  });

  let found = 0;
  const deferred = !runsInline;
  if (!deferred) {
    try {
      found = await runLeadRunById(supabase, data.id as string);
    } catch {
      // Left running; the worker/cron finishes it.
    }
  }

  return NextResponse.json({ ok: true, runId: data.id, queries: queries.length, found, deferred });
}

const deleteSchema = z.object({
  ids: z.array(z.string().uuid()).max(1000).optional(),
  all: z.boolean().optional(),
});

/** Deletes lead runs (history). Queued websites/contacts are kept. */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { ids, all } = parsed.data;
  if (!all && !ids?.length) {
    return NextResponse.json({ error: "Pass run ids, or all: true to clear history." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("lead_runs")
    .delete()
    .eq("workspace_id", session.workspace.id)
    .neq("status", "running");
  if (ids?.length) query = query.in("id", ids);

  const { data, error } = await query.select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const deleted = (data ?? []).length;
  if (deleted > 0) {
    await logActivity(supabase, {
      workspaceId: session.workspace.id,
      actorId: session.userId,
      action: "leads.runs_deleted",
      entityType: "lead_run",
      meta: { count: deleted, all: Boolean(all) },
    });
  }

  return NextResponse.json({ ok: true, deleted });
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
