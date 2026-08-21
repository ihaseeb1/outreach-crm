import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The email history for one publisher, for reading next to a form.
 *
 * Editing a deal meant leaving the page to check the quote: the rate card is on
 * screen but the message it came from is in the inbox, so verifying "is Casino
 * really 400?" cost a round trip and lost whatever had been typed. This is that
 * thread, fetched in place.
 *
 * Addressed by contact, conversation, or domain — a deal has at least one of
 * the three, and a deal typed in by hand has only the domain. Read-only, so the
 * request-scoped client is used and RLS is the only access check needed.
 */

/** Enough of a long quote to read; a whole newsletter thread is not the point. */
const MAX_BODY = 20_000;
const MAX_MESSAGES = 30;

/** Not exported: a route module may only export handlers and route config. */
interface ThreadMessage {
  id: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  truncated: boolean;
  from_email: string | null;
  to_email: string | null;
  mailbox: string | null;
  at: string;
  status: string;
  is_bounce: boolean;
  is_auto_reply: boolean;
  step_number: number | null;
}

interface MessageRow {
  id: string;
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string | null;
  from_email: string | null;
  to_email: string | null;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
  status: string;
  is_bounce: boolean;
  is_auto_reply: boolean;
  step_number: number | null;
  mailboxes: { email: string } | { email: string }[] | null;
}

function mailboxEmail(row: MessageRow): string | null {
  const embedded = Array.isArray(row.mailboxes) ? row.mailboxes[0] : row.mailboxes;
  return embedded?.email ?? null;
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const contactId = params.get("contact_id");
  const conversationId = params.get("conversation_id");
  const domain = (params.get("domain") ?? "").trim().toLowerCase();

  if (!contactId && !conversationId && !domain) {
    return NextResponse.json(
      { error: "Pass a contact_id, conversation_id or domain." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const contactIds = new Set<string>();
  if (contactId) contactIds.add(contactId);

  if (conversationId) {
    const { data } = await supabase
      .from("conversations")
      .select("contact_id")
      .eq("id", conversationId)
      .eq("workspace_id", session.workspace.id)
      .maybeSingle();
    const resolved = (data as { contact_id: string } | null)?.contact_id;
    if (resolved) contactIds.add(resolved);
  }

  // The domain is the fallback, and it is a real one: a publisher answers from
  // whatever address they like, so matching the deal's domain against both the
  // contact's domain and its address finds the thread a stored contact_id would
  // have missed anyway.
  if (domain) {
    const bare = domain.replace(/^www\./, "");
    const { data } = await supabase
      .from("contacts")
      .select("id")
      .eq("workspace_id", session.workspace.id)
      .or(`domain.ilike.%${bare}%,email.ilike.%@${bare}`)
      .limit(50);
    for (const row of (data ?? []) as { id: string }[]) contactIds.add(row.id);
  }

  if (contactIds.size === 0) {
    return NextResponse.json({ messages: [], reason: "no_contact" });
  }

  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, direction, subject, body, from_email, to_email, created_at, sent_at, received_at, status, is_bounce, is_auto_reply, step_number, mailboxes(email)",
    )
    .eq("workspace_id", session.workspace.id)
    .in("contact_id", [...contactIds])
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const messages: ThreadMessage[] = ((data ?? []) as unknown as MessageRow[]).map(
    (row) => {
      const body = row.body ?? "";
      return {
        id: row.id,
        direction: row.direction,
        subject: row.subject,
        body: body.slice(0, MAX_BODY),
        truncated: body.length > MAX_BODY,
        from_email: row.from_email,
        to_email: row.to_email,
        mailbox: mailboxEmail(row),
        // Whichever timestamp the message actually has: an inbound message is
        // stamped `received_at`, an outbound one `sent_at`, and a queued or
        // failed one only has `created_at`.
        at: row.received_at ?? row.sent_at ?? row.created_at,
        status: row.status,
        is_bounce: row.is_bounce,
        is_auto_reply: row.is_auto_reply,
        step_number: row.step_number,
      };
    },
  );

  return NextResponse.json({ messages });
}
