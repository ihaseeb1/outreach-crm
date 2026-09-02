import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl, normalizeUrl } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import type { DiscoveredSite } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  runId: z.string().uuid(),
  ids: z.array(z.string().uuid()).min(1).max(1000),
});

/**
 * Sends selected discovered sites into the existing prospecting queue.
 *
 * Each site becomes a pending `website` (the same rows the scrape cron already
 * consumes), carrying its discovery provenance in `meta`. Sites already known
 * to prospecting are linked, not re-queued — nothing existing is mutated. A
 * `scrape_job` is created for the newly-queued sites so they show up as a batch
 * on the Prospecting page. Idempotent: sites already pushed are skipped.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const workspaceId = session.workspace.id;
  const supabase = await createSupabaseServerClient();

  // Only this workspace's sites, in this run, not already pushed.
  const { data: siteRows, error: loadError } = await supabase
    .from("discovered_sites")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("run_id", parsed.data.runId)
    .in("id", parsed.data.ids)
    .is("pushed_website_id", null);

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }
  const sites = (siteRows ?? []) as DiscoveredSite[];
  if (sites.length === 0) {
    return NextResponse.json({ ok: true, pushed: 0, queued: 0 });
  }

  // Map each site to a target URL (its guest-post page, else the domain root).
  const targets = sites.map((site) => {
    const url = normalizeUrl(site.guest_post_url || `https://${site.root_domain}`);
    return { site, url, domain: site.root_domain || domainFromUrl(url) };
  });
  const urls = [...new Set(targets.map((t) => t.url))];

  // Which of these URLs are already prospecting websites?
  const { data: existingRows } = await supabase
    .from("websites")
    .select("id, url")
    .eq("workspace_id", workspaceId)
    .in("url", urls);
  const urlToWebsite = new Map<string, string>();
  for (const row of (existingRows ?? []) as { id: string; url: string }[]) {
    urlToWebsite.set(row.url, row.id);
  }

  const newTargets = targets.filter((t) => !urlToWebsite.has(t.url));

  // Queue the new ones under a fresh scrape job.
  let jobId: string | null = null;
  if (newTargets.length > 0) {
    const { data: job, error: jobError } = await supabase
      .from("scrape_jobs")
      .insert({
        workspace_id: workspaceId,
        created_by: session.userId,
        input_urls: newTargets.map((t) => t.url),
        status: "pending",
        total_count: newTargets.length,
      })
      .select("id")
      .single();
    if (jobError || !job) {
      return NextResponse.json(
        { error: jobError?.message ?? "Could not create prospecting job." },
        { status: 500 },
      );
    }
    jobId = (job as { id: string }).id;

    const { data: inserted, error: insertError } = await supabase
      .from("websites")
      .insert(
        newTargets.map((t) => ({
          workspace_id: workspaceId,
          scrape_job_id: jobId,
          url: t.url,
          domain: t.domain,
          status: "pending",
          emails_found: 0,
          meta: {
            discovery: {
              run_id: parsed.data.runId,
              discovered_site_id: t.site.id,
              guest_post_url: t.site.guest_post_url,
              matched_footprint: t.site.matched_footprint,
              opportunity_score: t.site.opportunity_score,
            },
          },
        })),
      )
      .select("id, url");
    if (insertError) {
      // Roll the empty job back so it doesn't linger as a phantom batch.
      await supabase.from("scrape_jobs").update({ status: "failed", error: insertError.message }).eq("id", jobId);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
    for (const row of (inserted ?? []) as { id: string; url: string }[]) {
      urlToWebsite.set(row.url, row.id);
    }
  }

  // Link each discovered site to its prospecting website.
  const now = new Date().toISOString();
  let pushed = 0;
  for (const { site, url } of targets) {
    const websiteId = urlToWebsite.get(url);
    if (!websiteId) continue;
    const { error: linkError } = await supabase
      .from("discovered_sites")
      .update({ pushed_website_id: websiteId, pushed_at: now })
      .eq("id", site.id)
      .eq("workspace_id", workspaceId);
    if (!linkError) pushed += 1;
  }

  await logActivity(supabase, {
    workspaceId,
    actorId: session.userId,
    action: "discovery.pushed_to_prospecting",
    entityType: "discovery_run",
    entityId: parsed.data.runId,
    meta: { pushed, queued: newTargets.length, jobId },
  });

  return NextResponse.json({ ok: true, pushed, queued: newTargets.length, jobId });
}
