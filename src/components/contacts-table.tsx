"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { planDomainDedupe } from "@/lib/domain-dedupe";
import type { Contact, ValidationStatus } from "@/types/db";

const VALIDATION_STYLES: Record<ValidationStatus, string> = {
  unknown: "bg-gray-100 text-gray-700",
  valid: "bg-green-50 text-[var(--color-ok)]",
  safe: "bg-green-50 text-[var(--color-ok)]",
  catch_all: "bg-amber-50 text-[var(--color-warn)]",
  role_account: "bg-blue-50 text-[var(--color-brand)]",
  invalid: "bg-red-50 text-[var(--color-danger)]",
  invalid_syntax: "bg-red-50 text-[var(--color-danger)]",
  no_mx: "bg-red-50 text-[var(--color-danger)]",
  disposable: "bg-amber-50 text-[var(--color-warn)]",
  spamtrap: "bg-red-50 text-[var(--color-danger)]",
  disabled: "bg-red-50 text-[var(--color-danger)]",
  inbox_full: "bg-amber-50 text-[var(--color-warn)]",
  suppressed: "bg-amber-50 text-[var(--color-warn)]",
  bounced: "bg-red-50 text-[var(--color-danger)]",
};

export interface StageOption {
  key: string;
  label: string;
}

/**
 * Contacts list with selection.
 *
 * Delete removes the row; "delete and suppress" also records the address so a
 * later re-scrape of the same site cannot quietly put it back on the send list.
 * That distinction matters — plain delete is not permanent while the website is
 * still queued.
 */
export function ContactsTable({
  contacts,
  stages,
}: {
  contacts: Contact[];
  stages: StageOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const allSelected = contacts.length > 0 && selected.size === contacts.length;
  const stageLabel = (key: string) =>
    stages.find((stage) => stage.key === key)?.label ?? key;

  /**
   * Ticks the surplus addresses so they can be reviewed before anything is
   * deleted. Deliberately a selection and not a delete: which of five
   * addresses is the real editor is a judgement worth eyeballing, and the
   * ranking is a heuristic.
   */
  function selectExtras(keepPerDomain: number) {
    const { drop } = planDomainDedupe(
      contacts.map((contact) => ({
        id: contact.id,
        email: contact.email,
        domain: contact.domain,
      })),
      keepPerDomain,
    );
    setSelected(new Set(drop.map((row) => row.id)));
    setMessage(
      drop.length === 0
        ? `Nothing surplus on this page at ${keepPerDomain} per domain.`
        : `Selected ${drop.length} surplus address(es), keeping the best ${keepPerDomain} per domain. Review, then delete.`,
    );
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function validate(force: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/contacts/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected], force }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Validation failed.");
      setMessage(
        payload.processed === 0
          ? "Nothing to do — those are already validated. Use Re-check to run them again."
          : `Checked ${payload.processed}: ${payload.valid} sendable, ${payload.invalid} not, ${payload.suppressed} suppressed.`,
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(suppress: boolean) {
    const what = suppress
      ? `Delete ${selected.size} contact(s) AND add them to the suppression list? They can never be emailed again.`
      : `Delete ${selected.size} contact(s)? A future scrape of the same site may re-add them.`;
    if (!confirm(what)) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/contacts", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selected], suppress }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Delete failed.");
      setMessage(
        `Deleted ${payload.deleted}${payload.suppressed ? `, suppressed ${payload.suppressed}` : ""}.`,
      );
      setSelected(new Set());
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void validate(false)}
        >
          Validate selected
        </button>
        <button
          className="btn-secondary"
          type="button"
          disabled={busy || selected.size === 0}
          title="Run the check again on contacts that already have a verdict"
          onClick={() => void validate(true)}
        >
          Re-check
        </button>
        <button
          className="btn-secondary text-[var(--color-danger)]"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void remove(false)}
        >
          Delete selected
        </button>
        <button
          className="btn-secondary text-[var(--color-danger)]"
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => void remove(true)}
        >
          Delete and suppress
        </button>
        {selected.size > 0 && (
          <span className="hint">{selected.size} selected</span>
        )}
        {message && <span className="hint">{message}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] pt-2">
        <span className="hint">One site, several addresses?</span>
        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy}
          onClick={() => selectExtras(1)}
        >
          Select extras, keep 1 per domain
        </button>
        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy}
          onClick={() => selectExtras(2)}
        >
          Keep 2 per domain
        </button>
        <span className="hint">
          Keeps a named person over a shared inbox, an editorial address over a
          generic one, and never keeps noreply or privacy addresses. Selects
          only — nothing is deleted until you press delete.
        </span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected ? new Set() : new Set(contacts.map((c) => c.id)),
                    )
                  }
                  aria-label="Select all contacts"
                />
              </th>
              <th>Email</th>
              <th>Name</th>
              <th>Domain</th>
              <th>Stage</th>
              <th>Validation</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(contact.id)}
                    onChange={() => toggle(contact.id)}
                    aria-label={`Select ${contact.email}`}
                  />
                </td>
                <td>
                  <Link
                    className="font-medium text-[var(--color-brand)] hover:underline"
                    href={`/contacts/${contact.id}`}
                  >
                    {contact.email}
                  </Link>
                </td>
                <td>
                  {[contact.first_name, contact.last_name]
                    .filter(Boolean)
                    .join(" ") || "—"}
                </td>
                <td>
                  {contact.domain ? (
                    <Link
                      className="hover:underline"
                      href={`/domains/${encodeURIComponent(contact.domain)}`}
                    >
                      {contact.domain}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <span className="badge bg-gray-100 text-gray-700">
                    {stageLabel(contact.pipeline_stage)}
                  </span>
                </td>
                <td>
                  <span
                    className={`badge ${VALIDATION_STYLES[contact.validation_status]}`}
                  >
                    {contact.validation_status.replace("_", " ")}
                  </span>
                </td>
                <td>{new Date(contact.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Adds a single contact by hand, for people you already know about. */
export function ContactAddForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          first_name: firstName || null,
          last_name: lastName || null,
          website: website || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not add.");
      setEmail("");
      setFirstName("");
      setLastName("");
      setWebsite("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn-secondary" type="button" onClick={() => setOpen(true)}>
        Add contact
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad w-full space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Add a contact</h2>
        <button className="hint hover:underline" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="new-email">
            Email
          </label>
          <input
            id="new-email"
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-first">
            First name
          </label>
          <input
            id="new-first"
            className="input"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-last">
            Last name
          </label>
          <input
            id="new-last"
            className="input"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-website">
            Website
          </label>
          <input
            id="new-website"
            className="input"
            placeholder="https://example.com"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      <button className="btn-primary" type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add contact"}
      </button>
    </form>
  );
}
