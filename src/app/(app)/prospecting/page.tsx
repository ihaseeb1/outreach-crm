import { RunJobButton } from "@/components/run-job-button";
import { UrlImportForm } from "@/components/url-import-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { ScrapeJob, Website } from "@/types/db";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  scraping: "bg-blue-50 text-[var(--color-brand)]",
  done: "bg-green-50 text-[var(--color-ok)]",
  failed: "bg-red-50 text-[var(--color-danger)]",
  skipped_robots: "bg-amber-50 text-[var(--color-warn)]",
};

export default async function ProspectingPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data: jobs } = await supabase
    .from("scrape_jobs")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: websites } = await supabase
    .from("websites")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(100);

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
          <RunJobButton job="scrape" label="Scrape next 5 websites" limit={5} />
          <RunJobButton job="validate" label="Validate next 100 emails" limit={100} />
        </div>
      </div>

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Scrape jobs
        </h2>
        {(jobs ?? []).length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">No jobs yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Processed</th>
                  <th>Emails found</th>
                </tr>
              </thead>
              <tbody>
                {(jobs as ScrapeJob[]).map((job) => (
                  <tr key={job.id}>
                    <td>{new Date(job.created_at).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${STATUS_STYLES[job.status] ?? ""}`}>
                        {job.status}
                      </span>
                    </td>
                    <td>
                      {job.processed_count} / {job.total_count}
                    </td>
                    <td>{job.found_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Websites
        </h2>
        {(websites ?? []).length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            Nothing queued yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Emails</th>
                  <th>Title</th>
                  <th>Scraped</th>
                </tr>
              </thead>
              <tbody>
                {(websites as Website[]).map((site) => (
                  <tr key={site.id}>
                    <td>
                      <a
                        className="text-[var(--color-brand)] hover:underline"
                        href={site.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {site.domain}
                      </a>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_STYLES[site.status] ?? ""}`}>
                        {site.status}
                      </span>
                      {site.error && (
                        <span className="hint ml-2" title={site.error}>
                          {site.error.slice(0, 40)}
                        </span>
                      )}
                    </td>
                    <td>{site.emails_found}</td>
                    <td className="max-w-xs truncate">{site.meta?.title ?? "—"}</td>
                    <td>
                      {site.scraped_at
                        ? new Date(site.scraped_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
