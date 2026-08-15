import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { ensureReplyPrefix } from "@/campaigns/run";
import { sendEmail } from "@/mail/send";
import type { Contact, Conversation } from "@/types/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversation_id: z.string().uuid(),
  body: z.string().min(1).max(50_000),
  subject: z.string().max(500).optional(),
  mailbox_id: z.string().uuid().optional(),
});

/** Replies inside a conversation, threaded under the message being answered. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const rls = await createSupabaseServerClient();

  const { data: conversationRow } = await rls
    .from("conversations")
    .select("*")
    .eq("id", parsed.data.conversation_id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!conversationRow) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  const conversation = conversationRow as Conversation;

  const { data: contactRow } = await rls
    .from("contacts")
    .select("*")
    .eq("id", conversation.contact_id)
    .maybeSingle();

  if (!contactRow) {
    return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  }
  const contact = contactRow as Contact;

  // Reply from the mailbox that owns the thread, so the conversation stays
  // coherent for the recipient.
  let mailboxId = parsed.data.mailbox_id ?? conversation.mailbox_id;
  if (!mailboxId) {
    const { data: fallback } = await rls
      .from("mailboxes")
      .select("id")
      .eq("workspace_id", session.workspace.id)
      .eq("is_active", true)
      .neq("health_status", "paused")
      .limit(1)
      .maybeSingle();
    mailboxId = (fallback as { id: string } | null)?.id ?? null;
  }

  if (!mailboxId) {
    return NextResponse.json(
      { error: "No active mailbox available to reply from." },
      { status: 400 },
    );
  }

  // Thread under the most recent message we can reference.
  const { data: lastMessage } = await rls
    .from("messages")
    .select("message_id, thread_id, subject")
    .eq("conversation_id", conversation.id)
    .not("message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const last = lastMessage as {
    message_id: string | null;
    thread_id: string | null;
    subject: string | null;
  } | null;

  const subject =
    parsed.data.subject?.trim() ||
    ensureReplyPrefix(last?.subject ?? conversation.subject ?? "Following up");

  const supabase = createSupabaseAdminClient();
  const outcome = await sendEmail(supabase, {
    workspaceId: session.workspace.id,
    mailboxId,
    contactId: contact.id,
    toEmail: contact.email,
    toName: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null,
    subject,
    body: parsed.data.body,
    kind: "campaign",
    inReplyTo: last?.message_id ?? null,
    references: last?.message_id ? [last.message_id] : undefined,
    threadId: last?.thread_id ?? null,
    actorId: session.userId,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.reason, code: outcome.code },
      { status: 400 },
    );
  }

  await supabase
    .from("conversations")
    .update({ is_read: true })
    .eq("id", conversation.id);

  return NextResponse.json({ ok: true, messageId: outcome.messageId });
}
