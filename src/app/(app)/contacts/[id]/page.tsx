import Link from "next/link";
import { notFound } from "next/navigation";

import { NotesPanel, TasksPanel } from "@/components/notes-tasks";
import { StageSelect } from "@/components/stage-select";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type {
  ActivityLogEntry,
  Contact,
  DealWithPrices,
  Note,
  PipelineStage,
  Task,
} from "@/types/db";

export const dynamic = "force-dynamic";

interface TimelineMessage {
  id: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string | null;
  status: string;
  is_bounce: boolean;
  is_auto_reply: boolean;
  from_email: string | null;
  to_email: string | null;
  created_at: string;
  /** Which of our own accounts sent it, or took delivery of it. */
  mailboxes: { email: string } | null;
}

export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data: contactRow } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!contactRow) notFound();
  const contact = contactRow as Contact;

  const [
    { data: stageRows },
    { data: messageRows },
    { data: dealRows },
    { data: noteRows },
    { data: taskRows },
    { data: activityRows },
    { data: conversationRow },
    { data: campaignRows },
  ] = await Promise.all([
    supabase
      .from("pipeline_stages")
      .select("key, label")
      .eq("workspace_id", session.workspace.id)
      .order("position", { ascending: true }),
    supabase
      .from("messages")
      .select(
        "id, direction, subject, body, status, is_bounce, is_auto_reply, from_email, to_email, created_at, mailboxes(email)",
      )
      .eq("contact_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("deals").select("*, deal_prices(*)").eq("contact_id", id),
    supabase
      .from("notes")
      .select("*")
      .eq("contact_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("tasks")
      .select("*")
      .eq("contact_id", id)
      .order("done", { ascending: true })
      .order("due_date", { ascending: true })
      .limit(50),
    supabase
      .from("activity_log")
      .select("*")
      .eq("workspace_id", session.workspace.id)
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("conversations")
      .select("id, mailboxes(email)")
      .eq("contact_id", id)
      .maybeSingle(),
    supabase
      .from("campaign_contacts")
      .select("id, status, current_step, next_send_at, campaigns(name)")
      .eq("contact_id", id)
      .limit(10),
  ]);

  const stages = (stageRows ?? []) as Pick<PipelineStage, "key" | "label">[];
  const messages = (messageRows ?? []) as unknown as TimelineMessage[];
  const deals = (dealRows ?? []) as unknown as DealWithPrices[];
  const notes = (noteRows ?? []) as Note[];
  const tasks = (taskRows ?? []) as Task[];
  const activity = (activityRows ?? []) as ActivityLogEntry[];
  const conversation = conversationRow as unknown as {
    id: string;
    mailboxes: { email: string } | null;
  } | null;
  const conversationId = conversation?.id ?? null;

  // Which account is handling this contact, and which one their reply came into.
  //
  // "Replied" on the pipeline is useless without it: with several mailboxes in
  // rotation there is no way to guess which Gmail to open, and no reason the
  // answer should have to be guessed at all — every message records its mailbox.
  const inboundMessages = messages.filter(
    (message) => message.direction === "inbound" && !message.is_bounce,
  );
  const replyMailbox =
    inboundMessages.find((message) => message.mailboxes?.email)?.mailboxes?.email ??
    null;
  const outreachMailbox =
    messages.find(
      (message) => message.direction === "outbound" && message.mailboxes?.email,
    )?.mailboxes?.email ?? null;
  const threadMailbox =
    replyMailbox ?? conversation?.mailboxes?.email ?? outreachMailbox;
  const enrolments = (campaignRows ?? []) as unknown as {
    id: string;
    status: string;
    current_step: number;
    next_send_at: string | null;
    campaigns: { name: string } | null;
  }[];

  const fullName =
    [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null;

  return (
    <div className="space-y-6">
      <div>
        <Link className="hint hover:underline" href="/contacts">
          ← Contacts
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{contact.email}</h1>
            <p className="hint mt-1">
              {fullName ? `${fullName} · ` : ""}
              {contact.domain ? (
                <Link
                  className="text-[var(--color-brand)] hover:underline"
                  href={`/domains/${encodeURIComponent(contact.domain)}`}
                >
                  {contact.domain}
                </Link>
              ) : (
                "no domain"
              )}
              {contact.phone ? ` · ${contact.phone}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StageSelect
              contactId={contact.id}
              value={contact.pipeline_stage}
              stages={stages}
            />
            {conversationId && (
              <Link className="btn-secondary" href={`/inbox?c=${conversationId}`}>
                Open conversation
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Fact label="Validation" value={contact.validation_status.replace("_", " ")} />
        <Fact
          label="Source"
          value={contact.source_url ? contact.source_url.replace(/^https?:\/\//, "") : "—"}
          href={contact.source_url ?? undefined}
        />
        <Fact
          label="Scraped"
          value={contact.scraped_at ? new Date(contact.scraped_at).toLocaleDateString() : "—"}
        />
        <Fact label="Added" value={new Date(contact.created_at).toLocaleDateString()} />
      </div>

      {threadMailbox && (
        <section className="card card-pad">
          <h2 className="text-sm font-semibold">Your mailbox for this contact</h2>
          <p className="mt-1 text-sm">
            {replyMailbox ? (
              <>
                They replied to{" "}
                <strong className="text-[var(--color-ink)]">{replyMailbox}</strong>
                {" — open that account to see it in Gmail."}
              </>
            ) : (
              <>
                Emailed from{" "}
                <strong className="text-[var(--color-ink)]">{threadMailbox}</strong>
                . No reply received yet.
              </>
            )}
          </p>
          {replyMailbox && outreachMailbox && outreachMailbox !== replyMailbox && (
            <p className="hint mt-1">
              Outreach went out from {outreachMailbox}, so the reply was
              forwarded or sent on to another of your accounts.
            </p>
          )}
        </section>
      )}

      {enrolments.length > 0 && (
        <section className="card card-pad space-y-2">
          <h2 className="text-sm font-semibold">Campaigns</h2>
          <ul className="space-y-1 text-sm">
            {enrolments.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.campaigns?.name ?? "—"}</span>
                <span className="badge bg-[var(--color-canvas)] text-[var(--color-muted)]">
                  {row.status}
                </span>
                <span className="hint">
                  step {row.current_step}
                  {row.next_send_at
                    ? ` · next ${new Date(row.next_send_at).toLocaleString()}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {deals.length > 0 && (
        <section className="card card-pad space-y-3">
          <h2 className="text-sm font-semibold">Deals</h2>
          {deals.map((deal) => (
            <div
              key={deal.id}
              className="rounded-md border border-[var(--color-line)] p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{deal.domain}</span>
                <span className="badge bg-[var(--color-canvas)]">{deal.status}</span>
              </div>
              <p className="hint mt-1">
                {deal.link_type ?? "—"} · {deal.placement_type ?? "—"} ·{" "}
                {deal.tat_days ? `${deal.tat_days}d TAT` : "TAT unknown"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(deal.deal_prices ?? []).map((price) => (
                  <span key={price.id} className="badge bg-green-50 text-[var(--color-ok)]">
                    {price.niche}: {price.currency} {Number(price.price).toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <Link className="text-sm text-[var(--color-brand)] hover:underline" href="/deals">
            All deals →
          </Link>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <NotesPanel contactId={contact.id} notes={notes} />
        <TasksPanel contactId={contact.id} tasks={tasks} />
      </div>

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Message history
        </h2>
        {messages.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            Nothing sent or received yet.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {messages.map((message) => (
              <li key={message.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {message.direction === "inbound" ? "Received" : "Sent"}
                    {message.is_bounce && " (bounce)"}
                    {message.is_auto_reply && " (auto-reply)"}
                    {message.status === "failed" && " (failed)"}
                  </span>
                  <span className="hint">
                    {new Date(message.created_at).toLocaleString()}
                  </span>
                </div>
                {/* Named per message, not just once at the top: rotation means
                    a sequence can legitimately run across two accounts. */}
                <p className="hint">
                  {message.direction === "inbound"
                    ? `${message.from_email ?? "them"} → ${
                        message.mailboxes?.email ?? message.to_email ?? "your mailbox"
                      }`
                    : `${
                        message.mailboxes?.email ?? message.from_email ?? "your mailbox"
                      } → ${message.to_email ?? contact.email}`}
                </p>
                <p className="text-sm">{message.subject ?? "(no subject)"}</p>
                {message.body && (
                  <p className="hint mt-1 line-clamp-2">
                    {message.body.slice(0, 200)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {activity.length > 0 && (
        <section className="card">
          <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
            Activity
          </h2>
          <ul className="divide-y divide-[var(--color-line)]">
            {activity.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between px-5 py-2 text-sm">
                <span>{entry.action.replace(/[._]/g, " ")}</span>
                <span className="hint">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div className="card card-pad">
      <p className="hint">{label}</p>
      {href ? (
        <a
          className="mt-1 block truncate text-sm text-[var(--color-brand)] hover:underline"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
        >
          {value}
        </a>
      ) : (
        <p className="mt-1 truncate text-sm font-medium">{value}</p>
      )}
    </div>
  );
}
