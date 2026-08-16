import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { domainFromUrl } from "@/lib/email";
import { pairColumns, parseContactImport } from "@/lib/import-parse";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { suppressedSubset } from "@/mail/suppressions";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    /** Combined mode: one line per contact, any separator. */
    text: z.string().max(1_000_000).optional(),
    /** Paired mode: two pasted columns, matched line by line. */
    websites: z.string().max(1_000_000).optional(),
    emails: z.string().max(1_000_000).optional(),
    /** Also queue every website seen here for scraping, to find more contacts. */
    scrapeWebsites: z.boolean().optional(),
  })
  .refine(
    (body) => Boolean(body.text?.trim() || body.websites?.trim() || body.emails?.trim()),
    { message: "Paste something to import." },
  );

const MAX_ROWS = 5000;

/**
 * Bulk-adds contacts from pasted text.
 *
 * Accepts whatever shape the list happens to be in — see parseContactImport.
 * Lines that carry only a website become scrape jobs instead of contacts,
 * since there is no address to add yet.
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

  const body = parsed.data;
  const result = body.text?.trim()
    ? parseContactImport(body.text)
    : pairColumns(body.websites ?? "", body.emails ?? "");
  const rows = result.rows.slice(0, MAX_ROWS);
  const truncated = result.rows.length - rows.length;

  const supabase = await createSupabaseServerClient();
  const workspaceId = session.workspace.id;

  // An address already suppressed is stored as suppressed rather than skipped,
  // so it shows up in the list with a reason instead of vanishing.
  const suppressed = rows.length
    ? await suppressedSubset(supabase, workspaceId, rows.map((row) => row.email))
    : new Set<string>();

  let added = 0;

  if (rows.length > 0) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("contacts")
      .upsert(
        rows.map((row) => ({
          workspace_id: workspaceId,
          email: row.email,
          first_name: row.firstName,
          last_name: row.lastName,
          website: row.website,
          domain: row.domain,
          scraped_at: now,
          validation_status: suppressed.has(row.email) ? "suppressed" : "unknown",
        })),
        { onConflict: "workspace_id,email", ignoreDuplicates: true },
      )
      .select("id");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    added = (data ?? []).length;
  }

  // Websites: the ones pasted alone, plus — when asked — the ones that came
  // alongside an address, so the crawler can look for more people at the site.
  const siteUrls = new Set(result.websitesOnly);
  if (body.scrapeWebsites) {
    for (const row of rows) {
      if (row.website) siteUrls.add(row.website);
    }
  }

  let queued = 0;

  if (siteUrls.size > 0) {
    const urls = [...siteUrls].slice(0, MAX_ROWS);

    const { data: job } = await supabase
      .from("scrape_jobs")
      .insert({
        workspace_id: workspaceId,
        created_by: session.userId,
        input_urls: urls,
        status: "pending",
        total_count: urls.length,
      })
      .select("id")
      .single();

    const jobId = (job as { id: string } | null)?.id ?? null;

    const { error: siteError } = await supabase.from("websites").upsert(
      urls.map((url) => ({
        workspace_id: workspaceId,
        scrape_job_id: jobId,
        url,
        domain: domainFromUrl(url),
        status: "pending",
        error: null,
        emails_found: 0,
      })),
      { onConflict: "workspace_id,url" },
    );

    if (!siteError) queued = urls.length;
  }

  await logActivity(supabase, {
    workspaceId,
    actorId: session.userId,
    action: "contact.imported",
    entityType: "contact",
    meta: {
      parsed: result.rows.length,
      added,
      queued,
      skipped: result.skipped.length,
    },
  });

  return NextResponse.json({
    ok: true,
    parsed: result.rows.length,
    added,
    duplicates: rows.length - added,
    queued,
    truncated,
    skipped: result.skipped.slice(0, 20),
    skippedTotal: result.skipped.length,
  });
}
