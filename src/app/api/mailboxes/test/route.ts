import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/workspace";
import { loadMailboxProvider } from "@/mail/providers";
import { sendEmail } from "@/mail/send";
import type { Mailbox } from "@/types/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  id: z.string().uuid(),
  /** Omit to send the test to the mailbox itself. */
  to: z.string().email().optional(),
  mode: z.enum(["verify", "send"]).default("verify"),
});

/**
 * Re-checks a mailbox's credentials, and optionally sends a real test email
 * through the full send pipeline (so the compliance guard, footer and
 * unsubscribe headers all get exercised).
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const { data: owned } = await supabase
    .from("mailboxes")
    .select("id, email, workspace_id")
    .eq("id", parsed.data.id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!owned) {
    return NextResponse.json({ error: "Mailbox not found." }, { status: 404 });
  }
  const mailbox = owned as Pick<Mailbox, "id" | "email" | "workspace_id">;

  if (parsed.data.mode === "verify") {
    const loaded = await loadMailboxProvider(supabase, mailbox.id);
    if (!loaded) {
      return NextResponse.json(
        { error: "No stored credentials for this mailbox." },
        { status: 400 },
      );
    }
    const result = await loaded.provider
      .verify()
      .finally(() => loaded.provider.close());

    await supabase
      .from("mailboxes")
      .update({ last_error: result.ok ? null : (result.error ?? "Verification failed") })
      .eq("id", mailbox.id);

    return NextResponse.json(
      result.ok ? { ok: true, smtp: true, imap: true } : { error: result.error, ...result },
      { status: result.ok ? 200 : 400 },
    );
  }

  const to = parsed.data.to ?? mailbox.email;

  // Sent as "manual" so it carries the postal-address footer and unsubscribe
  // headers exactly like a real campaign email would.
  const outcome = await sendEmail(supabase, {
    workspaceId: session.workspace.id,
    mailboxId: mailbox.id,
    toEmail: to,
    subject: "Outreach CRM test email",
    body:
      "This is a test send from Outreach CRM.\n\n" +
      "If you can read this, SMTP is working for this mailbox. " +
      "Check the footer below — the postal address and unsubscribe link are " +
      "added automatically to every campaign email.",
    kind: "manual",
    actorId: session.userId,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.reason, code: outcome.code },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, messageId: outcome.messageId, to });
}
