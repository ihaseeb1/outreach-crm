"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DealForm, type DealSaveResult } from "@/components/deal-form";

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
  threadMailboxId,
  threadMailboxEmail,
  mailboxes,
}: {
  conversationId: string;
  contactId: string;
  contactEmail: string;
  domain: string;
  isRead: boolean;
  status: string;
  messages: ThreadMessage[];
  hasDeal: boolean;
  /** The mailbox this thread belongs to; replies default to it. */
  threadMailboxId: string | null;
  threadMailboxEmail: string | null;
  mailboxes: { id: string; email: string }[];
}) {
  const router = useRouter();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [showDeal, setShowDeal] = useState(false);
  const [dealNote, setDealNote] = useState<string | null>(null);
  const [fromMailbox, setFromMailbox] = useState(threadMailboxId ?? "");

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
        body: JSON.stringify({
          conversation_id: conversationId,
          body: reply,
          // Omitted when it is the thread's own mailbox, so the server keeps
          // its existing behaviour rather than being told what it already knows.
          mailbox_id:
            fromMailbox && fromMailbox !== threadMailboxId ? fromMailbox : undefined,
        }),
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
          {status === "closed" ? "Move back to Open" : "Mark done"}
        </button>
        <button
          className="btn-primary px-2.5 py-1.5 text-xs"
          type="button"
          onClick={() => setShowDeal((current) => !current)}
        >
          {showDeal ? "Hide deal form" : hasDeal ? "Edit deal" : "Log deal"}
        </button>
      </div>

      <p className="hint">
        {status === "closed"
          ? "Marked done, so it is hidden from Open. A new reply brings it back on its own."
          : "“Mark done” only hides the thread from the Open tab — nothing is deleted, and a new reply reopens it automatically."}
      </p>

      {dealNote && (
        <p className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
          {dealNote}
        </p>
      )}

      {showDeal && (
        <div className="card card-pad">
          <h3 className="mb-3 text-sm font-semibold">Rate card</h3>
          <p className="hint mb-3">
            Saving also stars this thread in{" "}
            {threadMailboxEmail ?? "the mailbox that received it"}, so the deal is
            findable from Gmail as well as from here.
          </p>
          <DealForm
            compact
            defaults={{
              contact_id: contactId,
              conversation_id: conversationId,
              domain,
            }}
            onSaved={(result: DealSaveResult) => {
              setShowDeal(false);
              setDealNote(
                result.starred
                  ? `Deal saved and the thread starred in ${result.starred.mailbox}.`
                  : `Deal saved. The thread was not starred: ${
                      result.star_error ?? "no mailbox copy found"
                    }.`,
              );
            }}
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
        <div>
          <label className="label" htmlFor="reply-from">
            Reply from
          </label>
          <select
            id="reply-from"
            className="input"
            value={fromMailbox}
            onChange={(e) => setFromMailbox(e.target.value)}
          >
            {/* The thread's own mailbox may be paused or missing from the active
                list, so it is offered explicitly rather than silently dropped. */}
            {threadMailboxId &&
              !mailboxes.some((mailbox) => mailbox.id === threadMailboxId) && (
                <option value={threadMailboxId}>
                  {threadMailboxEmail ?? "This thread's mailbox"} (received here)
                </option>
              )}
            {mailboxes.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.email}
                {mailbox.id === threadMailboxId ? " (received here)" : ""}
              </option>
            ))}
          </select>
          {fromMailbox && fromMailbox !== threadMailboxId && (
            <p className="hint mt-1 text-[var(--color-warn)]">
              Replying from a different address than the one they wrote to. It
              still threads, but the reply arrives from a name they have not seen
              before — worth a line explaining why.
            </p>
          )}
        </div>

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
          Threaded under the last message either way, so it lands in the same
          conversation the recipient already has.
        </p>
      </form>
    </div>
  );
}
