import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { WORLDWIDE } from "@/discovery/geo";
import { enrichContactForDomain } from "@/discovery/enrich/run";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  domains: z.string().min(1).max(200_000),
});

/** How many sites to scrape inline so results come back within one request. */
const INLINE_SITE_CAP = 8;
const MAX_SEEDS = 500;

/**
 * Paste a list of publisher sites -> find their contact details, in real time.
 *
 * This crawls each pasted site directly for its best contact email (verified
 * with the in-house engine) and phone (E.164) — no search engine, no separate
 * worker — so results are there when the page reloads. The sites are also
 * stored as an author-crawl seed run, so the background worker can later look
 * for guest authors on them too.
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

  // Record the batch as a completed "manual seeds" run for traceability.
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

  // Store every seed as a discovered site opted into author-crawl (the worker
  // can later find guest authors on them).
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

  // Scrape contacts inline for the first N sites (fits one request); the rest
  // stay queued for the background worker.
  const inline = domains.slice(0, INLINE_SITE_CAP);
  let withEmail = 0;
  let verified = 0;
  const now = new Date().toISOString();

  for (const domain of inline) {
    const contact = await enrichContactForDomain(supabase, domain);
    if (contact.email) withEmail += 1;
    if (contact.emailStatus === "verified") verified += 1;

    await supabase.from("active_authors").upsert(
      {
        workspace_id: session.workspace.id,
        source_domain: domain,
        source_post_url: `https://${domain}`,
        destination_domain: domain,
        author_name: null,
        email: contact.email,
        email_status: contact.emailStatus,
        phone: contact.phone,
        phone_region: contact.phoneRegion,
        contact_confidence: contact.confidence,
        enriched_at: now,
        status: "new",
        meta: { direct_scrape: true, social: contact.social, emails_found: contact.emailsFound },
      },
      { onConflict: "workspace_id,source_post_url,destination_domain", ignoreDuplicates: false },
    );
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "publishers.seeded",
    entityType: "discovery_run",
    entityId: runId,
    meta: { domains: domains.length, scraped: inline.length, withEmail, verified },
  });

  return NextResponse.json({
    ok: true,
    seeded: domains.length,
    scraped: inline.length,
    withEmail,
    verified,
    queued: Math.max(0, domains.length - inline.length),
    runId,
  });
}
