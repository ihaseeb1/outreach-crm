import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { contactVars, renderTemplate } from "@/mail/template";
import { sendEmail } from "@/mail/send";
import type { Contact } from "@/types/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mailbox_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50_000),
});

/**
 * One-off templated send to a single contact. Variables like {{first_name}}
 * are resolved from the contact; everything else (suppression check, daily
 * limit, footer, unsubscribe headers) is handled by sendEmail().
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const rls = await createSupabaseServerClient();

  const { data: contactRow } = await rls
    .from("contacts")
    .select("*")
    .eq("id", parsed.data.contact_id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!contactRow) {
    return NextResponse.json({ error: "Contact not found." }, { status: 404 });
  }
  const contact = contactRow as Contact;

  const { data: mailbox } = await rls
    .from("mailboxes")
    .select("id")
    .eq("id", parsed.data.mailbox_id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!mailbox) {
    return NextResponse.json({ error: "Mailbox not found." }, { status: 404 });
  }

  const vars = contactVars(contact);
  const supabase = createSupabaseAdminClient();

  const outcome = await sendEmail(supabase, {
    workspaceId: session.workspace.id,
    mailboxId: parsed.data.mailbox_id,
    contactId: contact.id,
    toEmail: contact.email,
    toName: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null,
    subject: renderTemplate(parsed.data.subject, vars, `${contact.email}#subject`),
    body: renderTemplate(parsed.data.body, vars, `${contact.email}#body`),
    kind: "campaign",
    actorId: session.userId,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.reason, code: outcome.code },
      { status: 400 },
    );
  }

  // Move the contact along the pipeline on first touch.
  await supabase
    .from("contacts")
    .update({ pipeline_stage: "contacted" })
    .eq("id", contact.id)
    .eq("pipeline_stage", "new");

  return NextResponse.json({ ok: true, messageId: outcome.messageId });
}
