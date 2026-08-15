import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Contact, ValidationStatus } from "@/types/db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const VALIDATION_STYLES: Record<ValidationStatus, string> = {
  unknown: "bg-gray-100 text-gray-700",
  valid: "bg-green-50 text-[var(--color-ok)]",
  role_account: "bg-blue-50 text-[var(--color-brand)]",
  invalid_syntax: "bg-red-50 text-[var(--color-danger)]",
  no_mx: "bg-red-50 text-[var(--color-danger)]",
  disposable: "bg-amber-50 text-[var(--color-warn)]",
  suppressed: "bg-amber-50 text-[var(--color-warn)]",
  bounced: "bg-red-50 text-[var(--color-danger)]",
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "valid", label: "Valid" },
  { value: "role_account", label: "Role account" },
  { value: "unknown", label: "Not validated" },
  { value: "no_mx", label: "No MX" },
  { value: "invalid_syntax", label: "Invalid syntax" },
  { value: "disposable", label: "Disposable" },
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
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Domain</th>
                  <th>Validation</th>
                  <th>Source</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td className="font-medium">{contact.email}</td>
                    <td>
                      {[contact.first_name, contact.last_name]
                        .filter(Boolean)
                        .join(" ") || "—"}
                    </td>
                    <td>{contact.domain ?? "—"}</td>
                    <td>
                      <span
                        className={`badge ${VALIDATION_STYLES[contact.validation_status]}`}
                      >
                        {contact.validation_status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="max-w-xs truncate">
                      {contact.source_url ? (
                        <a
                          className="text-[var(--color-brand)] hover:underline"
                          href={contact.source_url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {contact.source_url.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{new Date(contact.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
