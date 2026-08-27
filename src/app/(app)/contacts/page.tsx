import Link from "next/link";

import { ContactImportForm } from "@/components/contact-import-form";
import { ContactAddForm, ContactsTable } from "@/components/contacts-table";
import { RunJobButton } from "@/components/run-job-button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Contact } from "@/types/db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "safe", label: "Safe (mailbox confirmed)" },
  { value: "valid", label: "Valid" },
  { value: "catch_all", label: "Catch-all" },
  { value: "role_account", label: "Role account" },
  { value: "unknown", label: "Not verified" },
  { value: "no_mx", label: "No MX" },
  { value: "invalid", label: "Invalid (no such mailbox)" },
  { value: "invalid_syntax", label: "Invalid syntax" },
  { value: "disposable", label: "Disposable" },
  { value: "spamtrap", label: "Spam trap" },
  { value: "disabled", label: "Disabled" },
  { value: "inbox_full", label: "Inbox full" },
  { value: "suppressed", label: "Suppressed" },
  { value: "bounced", label: "Bounced" },
];

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;

  const status = typeof params.status === "string" ? params.status : "";
  const domain = typeof params.domain === "string" ? params.domain : "";
  const search = typeof params.q === "string" ? params.q : "";
  const page = Math.max(1, Number.parseInt(String(params.page ?? "1"), 10) || 1);

  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("contacts")
    .select("*", { count: "exact" })
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (status) query = query.eq("validation_status", status);
  if (domain) query = query.ilike("domain", `%${domain}%`);
  if (search) query = query.ilike("email", `%${search}%`);

  const { data, count } = await query;
  const contacts = (data ?? []) as Contact[];
  const total = count ?? 0;

  const { count: unvalidated } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", session.workspace.id)
    .eq("validation_status", "unknown");

  const { data: stageRows } = await supabase
    .from("pipeline_stages")
    .select("key, label")
    .eq("workspace_id", session.workspace.id)
    .order("position", { ascending: true });
  const stages = (stageRows ?? []) as { key: string; label: string }[];

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const exportQuery = new URLSearchParams();
  if (status) exportQuery.set("status", status);
  if (domain) exportQuery.set("domain", domain);
  if (search) exportQuery.set("q", search);

  const pageHref = (targetPage: number) => {
    const next = new URLSearchParams(exportQuery);
    next.set("page", String(targetPage));
    return `/contacts?${next.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="hint mt-1">{total.toLocaleString()} matching contact(s)</p>
        </div>
        <a
          className="btn-secondary"
          href={`/api/contacts/export?${exportQuery.toString()}`}
        >
          Export CSV
        </a>
      </div>

      {/* Both collapse to a single button until opened, so the page stays calm
          until you actually want to add something. */}
      <div className="flex flex-wrap items-center gap-2">
        <ContactImportForm />
        <ContactAddForm />
        <RunJobButton
          job="validate"
          label={`Verify ${unvalidated ?? 0} unchecked`}
          limit={100}
        />
      </div>

      {(unvalidated ?? 0) > 0 && (
        <p className="hint">
          A contact added by hand, pasted in, or scraped starts as{" "}
          <strong>not verified</strong>. Verification checks syntax, rejects
          disposable and spam-trap domains, catches likely typos, and looks up
          the domain&rsquo;s MX records — anything undeliverable is removed and
          suppressed automatically. It runs on every cron tick (100 at a time),
          on import, and when you press <strong>Verify selected</strong> below.
          The individual-mailbox (deep SMTP) check runs from the verify worker;
          each contact&rsquo;s <strong>score</strong> shows in the table so you
          can clean the list before adding anyone to a campaign.
        </p>
      )}

      <form method="get" className="card card-pad grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="q">
            Email contains
          </label>
          <input id="q" name="q" className="input" defaultValue={search} />
        </div>
        <div>
          <label className="label" htmlFor="domain">
            Domain contains
          </label>
          <input id="domain" name="domain" className="input" defaultValue={domain} />
        </div>
        <div>
          <label className="label" htmlFor="status">
            Validation
          </label>
          <select id="status" name="status" className="input" defaultValue={status}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button className="btn-primary" type="submit">
            Filter
          </button>
          <Link className="btn-secondary" href="/contacts">
            Reset
          </Link>
        </div>
      </form>

      <section className="card">
        {contacts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">
            No contacts yet. Queue some websites in{" "}
            <Link className="text-[var(--color-brand)] hover:underline" href="/prospecting">
              Prospecting
            </Link>
            .
          </p>
        ) : (
          <div className="p-5">
            <ContactsTable contacts={contacts} stages={stages} />
          </div>
        )}
      </section>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="hint">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link className="btn-secondary" href={pageHref(page - 1)}>
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link className="btn-secondary" href={pageHref(page + 1)}>
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
