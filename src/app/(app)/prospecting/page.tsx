import Link from "next/link";

import { RunJobButton } from "@/components/run-job-button";
import { ScrapeJobsTable } from "@/components/scrape-jobs-table";
import { UrlImportForm } from "@/components/url-import-form";
import { WebsiteTable } from "@/components/website-table";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { ScrapeJob, Website } from "@/types/db";

export const dynamic = "force-dynamic";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Queued" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "skipped_robots", label: "Blocked by robots.txt" },
  { value: "scraping", label: "In progress" },
];

const HTTP_OPTIONS = [
  { value: "", label: "Any response" },
  { value: "errors", label: "Any error (4xx / 5xx)" },
  { value: "403", label: "403 Forbidden" },
  { value: "404", label: "404 Not found" },
  { value: "429", label: "429 Rate limited" },
  { value: "500", label: "500 Server error" },
  { value: "none", label: "No response at all" },
];

const PAGE_SIZE = 100;

export default async function ProspectingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;

  const status = typeof params.status === "string" ? params.status : "";
  const http = typeof params.http === "string" ? params.http : "";
  const domain = typeof params.domain === "string" ? params.domain : "";
  const noEmails = params.no_emails === "1";

  const supabase = await createSupabaseServerClient();

  // Fetch a few extra and drop soft-deleted ones in JS, so the query never
  // references the deleted_at column (which may predate migration 0010).
  const { data: jobRows } = await supabase
    .from("scrape_jobs")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(30);
  const jobs = ((jobRows ?? []) as ScrapeJob[])
    .filter((job) => !job.deleted_at)
    .slice(0, 10);

  const canDeleteJobs =
    session.workspace.owner_id === session.userId ||
    session.appRole === "super_admin" ||
    session.appRole === "admin";

  let query = supabase
    .from("websites")
    .select("*", { count: "exact" })
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (status) query = query.eq("status", status);
  if (domain) query = query.ilike("domain", `%${domain}%`);
  if (noEmails) query = query.eq("emails_found", 0);

  if (http === "errors") query = query.gte("http_status", 400);
  else if (http === "none") query = query.is("http_status", null);
  else if (http) query = query.eq("http_status", Number.parseInt(http, 10));

  const { data: websites, count } = await query;
  const rows = (websites ?? []) as Website[];

  // Counts for the shortcut buttons, so the problem piles are visible without
  // having to guess which filter to try.
  const { count: failedCount } = await supabase
    .from("websites")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", session.workspace.id)
    .eq("status", "failed");

  const { count: blockedCount } = await supabase
    .from("websites")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", session.workspace.id)
    .gte("http_status", 400);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Prospecting</h1>
        <p className="hint mt-1">
          Paste websites, scrape contact details, build the list.
        </p>
      </div>

      <UrlImportForm />

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Run a batch now</h2>
        <p className="hint">
          These run automatically on every cron tick. Use these buttons to process
          a slice immediately.
        </p>
        <div className="flex flex-wrap gap-4">
          <RunJobButton job="scrape" label="Scrape next 10 websites" limit={10} />
          <RunJobButton job="scrape" label="Scrape next 25" limit={25} />
          <RunJobButton job="validate" label="Validate next 100 emails" limit={100} />
        </div>
      </div>

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Scrape jobs
        </h2>
        {jobs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">No jobs yet.</p>
        ) : (
          <ScrapeJobsTable jobs={jobs} canDelete={canDeleteJobs} />
        )}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="text-sm font-semibold">
            Websites{" "}
            <span className="hint font-normal">
              ({(count ?? 0).toLocaleString()} matching
              {(count ?? 0) > PAGE_SIZE ? `, showing ${PAGE_SIZE}` : ""})
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            <Link className="btn-secondary" href="/prospecting?status=failed">
              Failed ({failedCount ?? 0})
            </Link>
            <Link className="btn-secondary" href="/prospecting?http=errors">
              HTTP errors ({blockedCount ?? 0})
            </Link>
            <Link className="btn-secondary" href="/prospecting?status=done&no_emails=1">
              Done, no emails
            </Link>
          </div>
        </div>

        <form method="get" className="grid gap-3 px-5 py-4 sm:grid-cols-5">
          <div>
            <label className="label" htmlFor="domain">
              Domain contains
            </label>
            <input id="domain" name="domain" className="input" defaultValue={domain} />
          </div>
          <div>
            <label className="label" htmlFor="status">
              Status
            </label>
            <select id="status" name="status" className="input" defaultValue={status}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="http">
              HTTP response
            </label>
            <select id="http" name="http" className="input" defaultValue={http}>
              {HTTP_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="no_emails"
                value="1"
                defaultChecked={noEmails}
              />
              No emails found
            </label>
          </div>
          <div className="flex items-end gap-2">
            <button className="btn-primary" type="submit">
              Filter
            </button>
            <Link className="btn-secondary" href="/prospecting">
              Reset
            </Link>
          </div>
        </form>

        <div className="px-5 pb-5">
          {rows.length === 0 ? (
            <p className="py-6 text-sm text-[var(--color-muted)]">
              Nothing matches this filter.
            </p>
          ) : (
            <WebsiteTable websites={rows} />
          )}
        </div>
      </section>
    </div>
  );
}
