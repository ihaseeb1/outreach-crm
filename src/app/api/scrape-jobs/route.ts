import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl, isValidHttpUrl, normalizeUrl } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  urls: z.string().min(1).max(500_000),
});

const MAX_URLS_PER_JOB = 2000;

/** Creates a scrape job from pasted/uploaded URLs and queues each website. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const candidates = parsed.data.urls
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const urls: string[] = [];
  const rejected: string[] = [];

  for (const candidate of candidates) {
    if (!isValidHttpUrl(candidate)) {
      rejected.push(candidate);
      continue;
    }
    const normalized = normalizeUrl(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (urls.length < MAX_URLS_PER_JOB) urls.push(normalized);
  }

  if (urls.length === 0) {
    return NextResponse.json(
      { error: "No valid URLs found.", rejected: rejected.slice(0, 10) },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();

  const { data: job, error: jobError } = await supabase
    .from("scrape_jobs")
    .insert({
      workspace_id: session.workspace.id,
      created_by: session.userId,
      input_urls: urls,
      status: "pending",
      total_count: urls.length,
    })
    .select("id")
    .single();

  if (jobError || !job) {
    return NextResponse.json(
      { error: jobError?.message ?? "Could not create job." },
      { status: 500 },
    );
  }

  const jobId = (job as { id: string }).id;

  // Re-submitting a known URL re-queues it rather than creating a duplicate.
  const { error: sitesError } = await supabase.from("websites").upsert(
    urls.map((url) => ({
      workspace_id: session.workspace.id,
      scrape_job_id: jobId,
      url,
      domain: domainFromUrl(url),
      status: "pending",
      error: null,
      emails_found: 0,
    })),
    { onConflict: "workspace_id,url" },
  );

  if (sitesError) {
    await supabase
      .from("scrape_jobs")
      .update({ status: "failed", error: sitesError.message })
      .eq("id", jobId);
    return NextResponse.json({ error: sitesError.message }, { status: 500 });
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "scrape.job_created",
    entityType: "scrape_job",
    entityId: jobId,
    meta: { count: urls.length, rejected: rejected.length },
  });

  return NextResponse.json({
    ok: true,
    jobId,
    queued: urls.length,
    rejected: rejected.length,
  });
}
