import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fmtDateTime } from "@/lib/datetime";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await requireSession();
  const workspaceId = session.workspace.id;
  const supabase = await createSupabaseServerClient();

  const countRows = async (table: string) => {
    const { count } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    return count ?? 0;
  };

  const [websites, contacts, suppressions] = await Promise.all([
    countRows("websites"),
    countRows("contacts"),
    countRows("suppressions"),
  ]);

  const { count: validContacts } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("validation_status", ["valid", "role_account"]);

  const { count: pendingSites } = await supabase
    .from("websites")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "pending");

  const { data: recentJobs } = await supabase
    .from("scrape_jobs")
    .select("id, status, total_count, processed_count, found_count, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(5);

  const postalAddressSet = Boolean(session.workspace.sending_postal_address);

  const stats = [
    { label: "Websites", value: websites, href: "/prospecting" },
    { label: "Contacts", value: contacts, href: "/contacts" },
    { label: "Sendable contacts", value: validContacts ?? 0, href: "/contacts?status=valid" },
    { label: "Suppressed", value: suppressions, href: "/suppressions" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="hint mt-1">{session.workspace.name}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.label} href={stat.href} className="card card-pad hover:border-[var(--color-brand)]">
            <p className="hint">{stat.label}</p>
            <p className="mt-1 text-2xl font-semibold">{stat.value.toLocaleString()}</p>
          </Link>
        ))}
      </div>

      <section className="card card-pad">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Compliance checklist
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          <ChecklistItem
            ok={postalAddressSet}
            label="Sending postal address set (required by CAN-SPAM before any campaign can send)"
            action={{ href: "/settings", label: "Add it in Settings" }}
          />
          <ChecklistItem ok label="Global suppression list active — checked before every send" />
          <ChecklistItem ok label="robots.txt respected by the scraper, with crawl delay" />
          <ChecklistItem ok label="Source URL and scrape date recorded per contact" />
        </ul>
      </section>

      <section className="card">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="text-sm font-semibold">Recent scrape jobs</h2>
          <Link className="text-sm text-[var(--color-brand)] hover:underline" href="/prospecting">
            New job
          </Link>
        </div>

        {(recentJobs ?? []).length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            No scrape jobs yet. Paste a list of URLs in Prospecting to get started.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Emails found</th>
                </tr>
              </thead>
              <tbody>
                {(recentJobs as JobRow[]).map((job) => (
                  <tr key={job.id}>
                    <td>{fmtDateTime(job.created_at)}</td>
                    <td>{job.status}</td>
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

      {(pendingSites ?? 0) > 0 && (
        <p className="hint">
          {pendingSites} website(s) waiting to be scraped — the batch job picks them
          up on the next tick, or run it now from Prospecting.
        </p>
      )}
    </div>
  );
}

interface JobRow {
  id: string;
  status: string;
  total_count: number;
  processed_count: number;
  found_count: number;
  created_at: string;
}

function ChecklistItem({
  ok,
  label,
  action,
}: {
  ok: boolean;
  label: string;
  action?: { href: string; label: string };
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full text-center text-[10px] leading-4 text-white ${
          ok ? "bg-[var(--color-ok)]" : "bg-[var(--color-warn)]"
        }`}
      >
        {ok ? "✓" : "!"}
      </span>
      <span>
        {label}
        {!ok && action && (
          <>
            {" — "}
            <Link className="text-[var(--color-brand)] hover:underline" href={action.href}>
              {action.label}
            </Link>
          </>
        )}
      </span>
    </li>
  );
}
