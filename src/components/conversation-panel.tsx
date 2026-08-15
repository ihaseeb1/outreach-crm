"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DealForm } from "@/components/deal-form";

export interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string | null;
  from_email: string | null;
  to_email: string | null;
  created_at: string;
}

/** Thread view with a reply box and the "Log deal" rate-card form. */
export function ConversationPanel({
  conversationId,
  contactId,
  contactEmail,
  domain,
  isRead,
  status,
  messages,
  hasDeal,
}: {
  conversationId: string;
  contactId: string;
  contactEmail: string;
  domain: string;
  isRead: boolean;
  status: string;
  messages: ThreadMessage[];
  hasDeal: boolean;
}) {
  const router = useRouter();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [showDeal, setShowDeal] = useState(false);

  async function patch(body: Record<string, unknown>) {
    await fetch("/api/conversations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: conversationId, ...body }),
    });
    router.refresh();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSent(false);

    try {
      const response = await fetch("/api/conversations/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, body: reply }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not send.");
      setReply("");
      setSent(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          onClick={() => patch({ is_read: !isRead })}
        >
          Mark {isRead ? "unread" : "read"}
        </button>
        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          onClick={() => patch({ status: status === "closed" ? "open" : "closed" })}
        >
          {status === "closed" ? "Reopen" : "Close"}
        </button>
        <button
          className="btn-primary px-2.5 py-1.5 text-xs"
          type="button"
          onClick={() => setShowDeal((current) => !current)}
        >
          {showDeal ? "Hide deal form" : hasDeal ? "Edit deal" : "Log deal"}
        </button>
      </div>

      {showDeal && (
        <div className="card card-pad">
          <h3 className="mb-3 text-sm font-semibold">Rate card</h3>
          <DealForm
            compact
            defaults={{
              contact_id: contactId,
              conversation_id: conversationId,
              domain,
            }}
            onSaved={() => setShowDeal(false)}
          />
        </div>
      )}

      <div className="space-y-3">
        {messages.map((message) => (
          <article
            key={message.id}
            className={`rounded-md border p-4 ${
              message.direction === "inbound"
                ? "border-[var(--color-line)] bg-[var(--color-surface)]"
                : "border-blue-100 bg-blue-50/40"
            }`}
          >
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">
                {message.direction === "inbound"
                  ? (message.from_email ?? contactEmail)
                  : `You → ${message.to_email ?? contactEmail}`}
              </span>
              <span className="hint">
                {new Date(message.created_at).toLocaleString()}
              </span>
            </div>
            {message.subject && (
              <p className="mb-2 text-sm font-medium">{message.subject}</p>
            )}
            <pre className="whitespace-pre-wrap font-sans text-sm text-[var(--color-ink)]">
              {message.body ?? ""}
            </pre>
          </article>
        ))}
      </div>

      <form onSubmit={send} className="card card-pad space-y-3">
        <label className="label" htmlFor="reply-body">
          Reply
        </label>
        <textarea
          id="reply-body"
          className="input min-h-32"
          placeholder={`Reply to ${contactEmail}…`}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" type="submit" disabled={busy || !reply.trim()}>
            {busy ? "Sending…" : "Send reply"}
          </button>
          {sent && <span className="hint text-[var(--color-ok)]">Sent.</span>}
          {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
        </div>
        <p className="hint">
          Sent from the mailbox that owns this thread, so it threads properly for
          the recipient.
        </p>
      </form>
    </div>
  );
}
