import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl, isValidHttpUrl, normalizeUrl } from "@/lib/email";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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

const deleteSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  /** Also delete contacts that came only from this job and were never contacted. */
  removeContacts: z.boolean().optional(),
});

/**
 * Deletes scrape jobs (spec §6), single or bulk. Owner/admin only.
 *
 * Soft delete: the job row is kept with `deleted_at` set so an accidental
 * delete is recoverable (the scrape cron purges anything older than 30 days).
 * The job's raw website rows are removed — contacts already promoted from them
 * survive, because contacts.website_id is `on delete set null`. With
 * `removeContacts`, contacts that came *only* from this job and were never
 * enrolled in a campaign are removed too.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isOwner = session.workspace.owner_id === session.userId;
  const isAdmin = session.appRole === "super_admin" || session.appRole === "admin";
  if (!isOwner && !isAdmin) {
    return NextResponse.json(
      { error: "Only the workspace owner or an admin can delete scrape jobs." },
      { status: 403 },
    );
  }

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { ids, removeContacts } = parsed.data;
  const workspaceId = session.workspace.id;
  const admin = createSupabaseAdminClient();

  // Only jobs in this workspace, and only ones that really exist.
  const { data: owned } = await admin
    .from("scrape_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("id", ids);
  const jobIds = ((owned ?? []) as { id: string }[]).map((row) => row.id);
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "No matching jobs." }, { status: 404 });
  }

  // The job's websites (raw results).
  const { data: siteRows } = await admin
    .from("websites")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("scrape_job_id", jobIds);
  const websiteIds = ((siteRows ?? []) as { id: string }[]).map((row) => row.id);

  let contactsRemoved = 0;
  if (removeContacts && websiteIds.length > 0) {
    // Contacts sourced only from these websites that were never enrolled in any
    // campaign. Enrolled contacts are never touched — live campaign data stays.
    const { data: candidateRows } = await admin
      .from("contacts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("website_id", websiteIds);
    const candidateIds = ((candidateRows ?? []) as { id: string }[]).map((r) => r.id);

    if (candidateIds.length > 0) {
      const { data: enrolledRows } = await admin
        .from("campaign_contacts")
        .select("contact_id")
        .eq("workspace_id", workspaceId)
        .in("contact_id", candidateIds);
      const enrolled = new Set(
        ((enrolledRows ?? []) as { contact_id: string }[]).map((r) => r.contact_id),
      );
      const toDelete = candidateIds.filter((id) => !enrolled.has(id));
      if (toDelete.length > 0) {
        await admin.from("contacts").delete().in("id", toDelete);
        contactsRemoved = toDelete.length;
      }
    }
  }

  // Remove the raw website rows (contacts.website_id → null keeps the contacts).
  if (websiteIds.length > 0) {
    await admin.from("websites").delete().in("id", websiteIds);
  }

  // Soft delete the job rows. If the deleted_at column is not there yet
  // (migration 0010 not applied), fall back to a hard delete so the button
  // still works — recovery just isn't available until the migration runs.
  const { error: softError } = await admin
    .from("scrape_jobs")
    .update({ deleted_at: new Date().toISOString() })
    .in("id", jobIds)
    .eq("workspace_id", workspaceId);
  if (softError) {
    await admin
      .from("scrape_jobs")
      .delete()
      .in("id", jobIds)
      .eq("workspace_id", workspaceId);
  }

  await logActivity(admin, {
    workspaceId,
    actorId: session.userId,
    action: "scrape.jobs_deleted",
    entityType: "scrape_job",
    entityId: jobIds[0] ?? null,
    meta: {
      jobs: jobIds.length,
      websites_removed: websiteIds.length,
      contacts_removed: contactsRemoved,
      soft: !softError,
    },
  });

  return NextResponse.json({
    ok: true,
    jobs: jobIds.length,
    websitesRemoved: websiteIds.length,
    contactsRemoved,
  });
}
