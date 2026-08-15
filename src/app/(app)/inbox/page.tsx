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
  subject: string | null;
  last_message_at: string;
  last_direction: "inbound" | "outbound" | null;
  is_read: boolean;
  status: string;
  contacts: { email: string; domain: string | null; first_name: string | null } | null;
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

  let listQuery = supabase
    .from("conversations")
    .select(
      "id, contact_id, subject, last_message_at, last_direction, is_read, status, contacts(email, domain, first_name)",
    )
    .eq("workspace_id", session.workspace.id)
    .order("last_message_at", { ascending: false })
    .limit(100);

  if (filter === "unread") listQuery = listQuery.eq("is_read", false);
  else if (filter === "open") listQuery = listQuery.eq("status", "open");

  const { data: listData } = await listQuery;
  const conversations = (listData ?? []) as unknown as ConversationRow[];

  const selected =
    conversations.find((row) => row.id === selectedId) ??
    (selectedId
      ? (((
          await supabase
            .from("conversations")
            .select(
              "id, contact_id, subject, last_message_at, last_direction, is_read, status, contacts(email, domain, first_name)",
            )
            .eq("id", selectedId)
            .eq("workspace_id", session.workspace.id)
            .maybeSingle()
        ).data ?? null) as unknown as ConversationRow | null)
      : null);

  let messages: ThreadMessage[] = [];
  let hasDeal = false;

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

  const unreadCount = conversations.filter((row) => !row.is_read).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inbox</h1>
          <p className="hint mt-1">
            Real replies from every mailbox in one place. Warmup mail, bounces and
            autoresponders never appear here.
          </p>
        </div>
        <RunJobButton job="inbound" label="Check for new replies" limit={5} />
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
              No conversations yet. Replies land here once a prospect writes back.
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
                    <p className="hint">
                      {new Date(row.last_message_at).toLocaleString()}
                      {row.status === "closed" && " · closed"}
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
              </div>

              <ConversationPanel
                conversationId={selected.id}
                contactId={selected.contact_id}
                contactEmail={selected.contacts?.email ?? ""}
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
