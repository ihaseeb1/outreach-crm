"use client";

import { useMemo, useState } from "react";

import { contactVars, renderTemplate, templateVariables } from "@/mail/template";

export interface ComposeContact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  website: string | null;
  domain: string | null;
  phone: string | null;
}

export interface ComposeMailbox {
  id: string;
  email: string;
}

const AVAILABLE_VARS = [
  "first_name",
  "last_name",
  "full_name",
  "email",
  "website",
  "domain",
];

export function ComposeForm({
  mailboxes,
  contacts,
}: {
  mailboxes: ComposeMailbox[];
  contacts: ComposeContact[];
}) {
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [subject, setSubject] = useState(
    "Quick question about {{domain}}",
  );
  const [body, setBody] = useState(
    "Hi {{first_name|there}},\n\n" +
      "I came across {{domain}} while researching sites in this space — really liked what you're publishing.\n\n" +
      "I write in a related niche and wondered whether you accept guest contributions or paid placements. If so, could you send over your rates and turnaround?\n\n" +
      "Thanks,\n",
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const contact = useMemo(
    () => contacts.find((c) => c.id === contactId) ?? null,
    [contacts, contactId],
  );

  const preview = useMemo(() => {
    if (!contact) return { subject, body };
    const vars = contactVars(contact);
    return {
      subject: renderTemplate(subject, vars),
      body: renderTemplate(body, vars),
    };
  }, [contact, subject, body]);

  const unknownVars = useMemo(
    () =>
      [...templateVariables(subject), ...templateVariables(body)].filter(
        (name) => !AVAILABLE_VARS.includes(name),
      ),
    [subject, body],
  );

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mailbox_id: mailboxId,
          contact_id: contactId,
          subject,
          body,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Send failed.");
      setResult(`Sent to ${contact?.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={onSubmit} className="card card-pad space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="mailbox">
              From
            </label>
            <select
              id="mailbox"
              className="input"
              value={mailboxId}
              onChange={(e) => setMailboxId(e.target.value)}
            >
              {mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.email}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="contact">
              To
            </label>
            <select
              id="contact"
              className="input"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              {contacts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.email}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="subject">
            Subject
          </label>
          <input
            id="subject"
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="body">
            Body
          </label>
          <textarea
            id="body"
            className="input min-h-64"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />
          <p className="hint mt-1">
            Variables: {AVAILABLE_VARS.map((v) => `{{${v}}}`).join(", ")}. Add a
            fallback with a pipe: <code>{"{{first_name|there}}"}</code>.
          </p>
        </div>

        {unknownVars.length > 0 && (
          <p className="text-sm text-[var(--color-warn)]">
            Unknown variable(s): {unknownVars.join(", ")} — these render as empty
            unless you give them a fallback.
          </p>
        )}

        <button
          className="btn-primary"
          type="submit"
          disabled={busy || !mailboxId || !contactId}
        >
          {busy ? "Sending…" : "Send email"}
        </button>

        {result && <p className="text-sm text-[var(--color-ok)]">{result}</p>}
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </form>

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Preview</h2>
        <div>
          <p className="hint">Subject</p>
          <p className="font-medium">{preview.subject}</p>
        </div>
        <div>
          <p className="hint">Body</p>
          <pre className="whitespace-pre-wrap font-sans text-sm">{preview.body}</pre>
        </div>
        <p className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
          Your postal address and a working one-click unsubscribe link are
          appended automatically — they are not shown here.
        </p>
      </div>
    </div>
  );
}
