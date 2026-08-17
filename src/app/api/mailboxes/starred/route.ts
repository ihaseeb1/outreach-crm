import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadMailboxProvider } from "@/mail/providers";
import { getSession } from "@/lib/workspace";
import type { Mailbox } from "@/types/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * The mail the user has starred, across every connected mailbox.
 *
 * Starring a reply in Gmail is the one hand-made signal that says "this quote
 * matters"; this makes that signal usable from the CRM, so a rate card can be
 * pulled from a thread the poller has not stored — anything older than the
 * mailbox's checkpoint, or in an account that was connected later.
 *
 * The admin client is required: `encrypted_credentials` is revoked from the
 * authenticated role, so a request-scoped client cannot load a provider.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const perMailbox = Math.min(
    Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "5", 10) || 5,
    20,
  );

  const supabase = createSupabaseAdminClient();

  const { data } = await supabase
    .from("mailboxes")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .eq("is_active", true)
    .not("encrypted_credentials", "is", null)
    .order("created_at", { ascending: true })
    .limit(20);

  const mailboxes = (data ?? []) as Mailbox[];
  const startedAt = Date.now();

  // All at once, and capped: IMAP is waiting, and the request has to answer
  // inside the same 60s ceiling everything else lives under.
  const settled = await Promise.all(
    mailboxes.map(async (mailbox) => {
      if (Date.now() - startedAt > 40_000) {
        return { mailbox: mailbox.email, error: "Skipped — ran out of time.", messages: [] };
      }

      const loaded = await loadMailboxProvider(supabase, mailbox.id);
      if (!loaded) {
        return { mailbox: mailbox.email, error: "No stored credentials.", messages: [] };
      }

      try {
        const found = await Promise.race([
          loaded.provider.fetchFlagged({ limit: perMailbox }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 25_000)),
        ]);

        if (!found) {
          return { mailbox: mailbox.email, error: "Timed out after 25s.", messages: [] };
        }

        return {
          mailbox: mailbox.email,
          error: null,
          messages: found.map((message) => ({
            from: message.fromEmail,
            fromName: message.fromName,
            subject: message.subject,
            receivedAt: message.receivedAt,
            text: message.text.slice(0, 20_000),
          })),
        };
      } catch (error) {
        return {
          mailbox: mailbox.email,
          error: error instanceof Error ? error.message : String(error),
          messages: [],
        };
      } finally {
        await loaded.provider.close().catch(() => undefined);
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    mailboxes: settled.length,
    starred: settled.reduce((sum, entry) => sum + entry.messages.length, 0),
    results: settled,
  });
}
