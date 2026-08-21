import Link from "next/link";

import { NotesPanel } from "@/components/notes-tasks";
import { fmtDate, fmtDateTime } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Contact, DealWithPrices, Note } from "@/types/db";

export const dynamic = "force-dynamic";

/**
 * Everything known about one publisher site. A domain usually has several
 * addresses, and what matters is the site, not whichever inbox replied.
 */
export default async function DomainPage({
  params,
}: {
  params: Promise<{ domain: string }>;
}) {
  const { domain: rawDomain } = await params;
  const domain = decodeURIComponent(rawDomain).toLowerCase();
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const [{ data: contactRows }, { data: dealRows }, { data: noteRows }, { data: websiteRow }] =
    await Promise.all([
      supabase
        .from("contacts")
        .select("*")
        .eq("workspace_id", session.workspace.id)
        .eq("domain", domain)
        .order("created_at", { ascending: true }),
      supabase
        .from("deals")
        .select("*, deal_prices(*)")
        .eq("workspace_id", session.workspace.id)
        .eq("domain", domain),
      supabase
        .from("notes")
        .select("*")
        .eq("workspace_id", session.workspace.id)
        .eq("domain", domain)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("websites")
        .select("url, status, meta, scraped_at, emails_found")
        .eq("workspace_id", session.workspace.id)
        .eq("domain", domain)
        .limit(1)
        .maybeSingle(),
    ]);

  const contacts = (contactRows ?? []) as Contact[];
  const deals = (dealRows ?? []) as unknown as DealWithPrices[];
  const notes = (noteRows ?? []) as Note[];
  const website = websiteRow as {
    url: string;
    status: string;
    meta: { title?: string; description?: string };
    scraped_at: string | null;
    emails_found: number;
  } | null;

  const contactIds = contacts.map((contact) => contact.id);
  const { data: messageRows } = contactIds.length
    ? await supabase
        .from("messages")
        .select("id, direction, subject, created_at, contact_id, is_bounce")
        .in("contact_id", contactIds)
        .order("created_at", { ascending: false })
        .limit(40)
    : { data: [] };

  const messages = (messageRows ?? []) as {
    id: string;
    direction: "inbound" | "outbound";
    subject: string | null;
    created_at: string;
    contact_id: string;
    is_bounce: boolean;
  }[];

  const emailById = new Map(contacts.map((contact) => [contact.id, contact.email]));

  return (
    <div className="space-y-6">
      <div>
        <Link className="hint hover:underline" href="/contacts">
          ← Contacts
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{domain}</h1>
        <p className="hint mt-1">
          {website?.meta?.title ?? "No page title recorded"}
          {website?.url && (
            <>
              {" · "}
              <a
                className="text-[var(--color-brand)] hover:underline"
                href={website.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                visit
              </a>
            </>
          )}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Contacts" value={contacts.length} />
        <Stat label="Deals" value={deals.length} />
        <Stat label="Messages" value={messages.length} />
        <Stat
          label="Last scraped"
          value={fmtDate(website?.scraped_at)}
        />
      </div>

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Contacts on this domain
        </h2>
        {contacts.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">None.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Stage</th>
                  <th>Validation</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      <Link
                        className="font-medium text-[var(--color-brand)] hover:underline"
                        href={`/contacts/${contact.id}`}
                      >
                        {contact.email}
                      </Link>
                    </td>
                    <td>
                      {[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td>{contact.pipeline_stage}</td>
                    <td>{contact.validation_status.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deals.length > 0 && (
        <section className="card card-pad space-y-3">
          <h2 className="text-sm font-semibold">Rate cards</h2>
          {deals.map((deal) => (
            <div key={deal.id} className="rounded-md border border-[var(--color-line)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="badge bg-[var(--color-canvas)]">{deal.status}</span>
                <span className="hint">
                  {deal.link_type ?? "—"} · {deal.placement_type ?? "—"} ·{" "}
                  {deal.tat_days ? `${deal.tat_days}d` : "TAT ?"}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(deal.deal_prices ?? []).map((price) => (
                  <span key={price.id} className="badge bg-green-50 text-[var(--color-ok)]">
                    {price.niche}: {price.currency} {Number(price.price).toLocaleString()}
                  </span>
                ))}
              </div>
              {deal.notes && <p className="hint mt-2">{deal.notes}</p>}
            </div>
          ))}
        </section>
      )}

      <NotesPanel domain={domain} notes={notes} />

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Message history
        </h2>
        {messages.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {messages.map((message) => (
              <li key={message.id} className="px-5 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>
                      {message.direction === "inbound" ? "In" : "Out"}
                      {message.is_bounce && " (bounce)"}
                    </strong>{" "}
                    {emailById.get(message.contact_id) ?? ""}
                  </span>
                  <span className="hint">
                    {fmtDateTime(message.created_at)}
                  </span>
                </div>
                <p className="hint">{message.subject ?? "(no subject)"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card card-pad">
      <p className="hint">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
