import type { SupabaseClient } from "@supabase/supabase-js";

import { loadMailboxProvider } from "@/mail/providers";

/**
 * Stars a conversation in the real mailbox it was received in.
 *
 * Logging a deal here should leave a trace where the user actually reads mail.
 * Gmail's star is the IMAP `\Flagged` flag, so this works through the same
 * app-password connection everything else uses — no Gmail API, no extra scope.
 *
 * Best-effort by design: the caller has already saved the deal, and a mailbox
 * that is slow, locked or offline must never turn that into a failure. Every
 * outcome is reported rather than thrown.
 */

export const STAR_FLAG = "\\Flagged";

export type StarOutcome =
  | { ok: true; folder: string; email: string }
  | { ok: false; reason: string };

export async function starConversationInMailbox(
  supabase: SupabaseClient,
  options: { workspaceId: string; conversationId: string; timeoutMs?: number },
): Promise<StarOutcome> {
  const { data: conversationRow } = await supabase
    .from("conversations")
    .select("id, mailbox_id")
    .eq("id", options.conversationId)
    .eq("workspace_id", options.workspaceId)
    .maybeSingle();

  const conversation = conversationRow as {
    id: string;
    mailbox_id: string | null;
  } | null;
  if (!conversation) return { ok: false, reason: "Conversation not found." };

  // The inbound message is the one that exists in the user's mailbox. Starring
  // our own outbound copy would flag it in Sent, where nobody looks.
  const { data: messageRow } = await supabase
    .from("messages")
    .select("message_id, mailbox_id")
    .eq("conversation_id", conversation.id)
    .eq("direction", "inbound")
    .not("message_id", "is", null)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const message = messageRow as {
    message_id: string | null;
    mailbox_id: string | null;
  } | null;

  if (!message?.message_id) {
    return { ok: false, reason: "No received message to star yet." };
  }

  const mailboxId = message.mailbox_id ?? conversation.mailbox_id;
  if (!mailboxId) {
    return { ok: false, reason: "This conversation has no mailbox attached." };
  }

  const loaded = await loadMailboxProvider(supabase, mailboxId);
  if (!loaded) return { ok: false, reason: "Mailbox has no stored credentials." };

  const { mailbox, provider } = loaded;

  try {
    // Bounded so a hung IMAP connection cannot eat the request's whole budget.
    const folder = await withTimeout(
      provider.flagByMessageId(message.message_id, [STAR_FLAG]),
      options.timeoutMs ?? 15_000,
    );

    if (!folder) {
      return { ok: false, reason: "Message not found in the mailbox." };
    }
    return { ok: true, folder, email: mailbox.email };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await provider.close().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms.`)), ms),
    ),
  ]);
}
