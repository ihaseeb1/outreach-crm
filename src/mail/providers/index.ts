import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptJson } from "@/lib/crypto";
import { SmtpProvider } from "@/mail/providers/smtp";
import type { MailboxCredentials, MailboxProvider } from "@/mail/providers/types";
import type { Mailbox } from "@/types/db";

/**
 * Builds the right provider for a mailbox. Phase 7 adds `gmail_oauth` and
 * `microsoft_oauth` branches here; callers stay unchanged.
 */
export function providerForMailbox(
  mailbox: Pick<Mailbox, "email" | "from_name" | "auth_type">,
  credentials: MailboxCredentials,
): MailboxProvider {
  switch (mailbox.auth_type) {
    case "app_password":
      return new SmtpProvider(credentials, mailbox.email, mailbox.from_name);
    case "oauth2":
      // Phase 7. Until then a mailbox cannot be saved with this auth type.
      throw new Error(
        "OAuth2 mailboxes are not available yet — connect with an app password for now.",
      );
    default:
      throw new Error(`Unknown auth type: ${mailbox.auth_type}`);
  }
}

/**
 * Loads a mailbox with its decrypted credentials. Server-only: the decrypted
 * value must never be returned to the browser or written to a log.
 */
export async function loadMailboxProvider(
  supabase: SupabaseClient,
  mailboxId: string,
): Promise<{ mailbox: Mailbox; provider: MailboxProvider } | null> {
  const { data } = await supabase
    .from("mailboxes")
    .select("*")
    .eq("id", mailboxId)
    .maybeSingle();

  if (!data) return null;
  const mailbox = data as Mailbox & { encrypted_credentials: string | null };
  if (!mailbox.encrypted_credentials) return null;

  const credentials = decryptJson<MailboxCredentials>(mailbox.encrypted_credentials);
  return { mailbox, provider: providerForMailbox(mailbox, credentials) };
}

export type { MailboxProvider, MailboxCredentials };
