import Link from "next/link";

import {
  ConversationPanel,
  type ThreadMessage,
} from "@/components/conversation-panel";
import { RunJobButton } from "@/components/run-job-button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

interface ConversationRow {
  id: string;
  contact_id: string;
  mailbox_id: string | null;
  subject: string | null;
  last_message_at: string;
  last_direction: "inbound" | "outbound" | null;
  is_read: boolean;
  status: string;
  contacts: { email: string; domain: string | null; first_name: string | null } | null;
  mailboxes: { email: string } | null;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const selectedId = typeof params.c === "string" ? params.c : null;
  const filter = typeof params.filter === "string" ? params.filter : "open";

  const supabase = await createSupabaseServerClient();

  // Only threads somebody has actually written back on.
  //
  // A conversation row is created by a database trigger on the first message,
  // outbound included, so simply listing conversations put every contact we had
  // merely emailed into the inbox — 56 sent emails read as 56 "conversations"
  // with nothing in them. Filtering on last_direction would not do either: our
  // own reply would make a real thread disappear again. So the set of threads
  // with at least one received message is resolved first, and the list is drawn
  // from that.
  const { data: repliedRows } = await supabase
    .from("messages")
    .select("conversation_id")
    .eq("workspace_id", session.workspace.id)
    .eq("direction", "inbound")
    .not("conversation_id", "is", null)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(5_000);

  const repliedIds = [
    ...new Set(
      ((repliedRows ?? []) as { conversation_id: string | null }[])
        .map((row) => row.conversation_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ].slice(0, 500);

  const conversationColumns =
    "id, contact_id, mailbox_id, subject, last_message_at, last_direction, is_read, status, contacts(email, domain, first_name), mailboxes(email)";

  let conversations: ConversationRow[] = [];

  if (repliedIds.length > 0) {
    let listQuery = supabase
      .from("conversations")
      .select(conversationColumns)
      .eq("workspace_id", session.workspace.id)
      .in("id", repliedIds)
      .order("last_message_at", { ascending: false })
      .limit(100);

    if (filter === "unread") listQuery = listQuery.eq("is_read", false);
    else if (filter === "open") listQuery = listQuery.eq("status", "open");

    const { data: listData } = await listQuery;
    conversations = (listData ?? []) as unknown as ConversationRow[];
  }

  // Counted across every replied thread, not just the ones this filter shows —
  // an unread badge that empties when you switch tabs is worse than none.
  const { count: unreadTotal } =
    repliedIds.length > 0
      ? await supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", session.workspace.id)
          .in("id", repliedIds)
          .eq("is_read", false)
      : { count: 0 };

  const selected =
    conversations.find((row) => row.id === selectedId) ??
    (selectedId
      ? (((
          await supabase
            .from("conversations")
            .select(conversationColumns)
            .eq("id", selectedId)
            .eq("workspace_id", session.workspace.id)
            .maybeSingle()
        ).data ?? null) as unknown as ConversationRow | null)
      : null);

  let messages: ThreadMessage[] = [];
  let hasDeal = false;

  // Every mailbox that could send a reply, so the thread can be answered from a
  // different address when the original one is paused or at its limit.
  const { data: mailboxRows } = await supabase
    .from("mailboxes")
    .select("id, email")
    .eq("workspace_id", session.workspace.id)
    .eq("is_active", true)
    .neq("health_status", "paused")
    .order("created_at", { ascending: true });

  const mailboxes = (mailboxRows ?? []) as { id: string; email: string }[];

  if (selected) {
    const [{ data: messageRows }, { count: dealCount }] = await Promise.all([
      supabase
        .from("messages")
        .select("id, direction, subject, body, from_email, to_email, created_at")
        .eq("conversation_id", selected.id)
        .order("created_at", { ascending: true })
        .limit(50),
      supabase
        .from("deals")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", session.workspace.id)
        .eq("contact_id", selected.contact_id),
    ]);

    messages = (messageRows ?? []) as ThreadMessage[];
    hasDeal = (dealCount ?? 0) > 0;

    // Opening a thread marks it read.
    if (!selected.is_read) {
      await supabase
        .from("conversations")
        .update({ is_read: true })
        .eq("id", selected.id);
    }
  }

  const unreadCount = unreadTotal ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="hint mt-1">
            Only threads someone has replied to. Emails you have merely sent stay
            out of here, as do warmup mail, bounces and autoresponders.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {/* Unlimited: someone pressing this is waiting on one specific reply
              and cannot know which mailbox it landed in, so a cap here would
              only ever hide the answer. */}
          <RunJobButton job="inbound" label="Check for new replies" />
          {/* Recovery, not routine. Inbound mail is read from a per-mailbox UID
              checkpoint, so anything fetched during the spell when replies could
              not be saved sits behind that mark and no ordinary poll will ever
              reach it again. This re-reads the last 200 UIDs; already-saved mail
              is skipped, so pressing it twice costs nothing but time. */}
          <RunJobButton
            job="inbound"
            label="Rescan recent mail"
            extra={{ rescan: 200 }}
            variant="ghost"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { key: "open", label: "Open" },
          { key: "unread", label: `Unread${unreadCount ? ` (${unreadCount})` : ""}` },
          { key: "all", label: "All" },
        ].map((tab) => (
          <Link
            key={tab.key}
            href={`/inbox?filter=${tab.key}`}
            className={`badge ${
              filter === tab.key
                ? "bg-blue-50 text-[var(--color-brand)]"
                : "bg-[var(--color-canvas)] text-[var(--color-muted)]"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="card max-h-[70vh] overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-muted)]">
              {filter === "open"
                ? "Nothing waiting. A thread appears here the moment somebody replies, and comes back if they reply again after you mark it done."
                : "No replies yet. Sent emails do not appear here — only threads a prospect has written back on."}
            </p>
          ) : (
            <ul>
              {conversations.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/inbox?filter=${filter}&c=${row.id}`}
                    className={`block border-b border-[var(--color-line)] px-4 py-3 hover:bg-[var(--color-canvas)] ${
                      selected?.id === row.id ? "bg-blue-50/60" : ""
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-sm ${
                          row.is_read ? "" : "font-semibold"
                        }`}
                      >
                        {row.contacts?.email ?? "Unknown"}
                      </span>
                      {!row.is_read && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-brand)]" />
                      )}
                    </div>
                    <p className="truncate text-xs text-[var(--color-muted)]">
                      {row.subject ?? "(no subject)"}
                    </p>
                    <p className="hint truncate">
                      {new Date(row.last_message_at).toLocaleString()}
                      {/* Which of the seven mailboxes this landed in — the whole
                          point of a shared inbox is not having to guess. */}
                      {row.mailboxes?.email && ` · ${row.mailboxes.email}`}
                      {row.status === "closed" && " · done"}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section>
          {!selected ? (
            <p className="card card-pad text-sm text-[var(--color-muted)]">
              Select a conversation to read it and reply.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="card card-pad">
                <h2 className="font-medium">{selected.contacts?.email}</h2>
                <p className="hint">
                  {selected.contacts?.domain ?? "—"} ·{" "}
                  {selected.subject ?? "(no subject)"}
                </p>
                <p className="hint mt-1">
                  Received by{" "}
                  <strong className="text-[var(--color-ink)]">
                    {selected.mailboxes?.email ?? "an unknown mailbox"}
                  </strong>
                  {selected.status === "closed" && " · marked done"}
                </p>
              </div>

              <ConversationPanel
                conversationId={selected.id}
                contactId={selected.contact_id}
                contactEmail={selected.contacts?.email ?? ""}
                threadMailboxId={selected.mailbox_id}
                threadMailboxEmail={selected.mailboxes?.email ?? null}
                mailboxes={mailboxes}
                domain={selected.contacts?.domain ?? ""}
                isRead
                status={selected.status}
                messages={messages}
                hasDeal={hasDeal}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
