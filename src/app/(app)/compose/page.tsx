import Link from "next/link";

import {
  ComposeForm,
  type ComposeContact,
  type ComposeMailbox,
} from "@/components/compose-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ComposePage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const [{ data: mailboxData }, { data: contactData }] = await Promise.all([
    supabase
      .from("mailboxes")
      .select("id, email")
      .eq("workspace_id", session.workspace.id)
      .eq("is_active", true)
      .neq("health_status", "paused")
      .order("created_at", { ascending: true }),
    supabase
      .from("contacts")
      .select("id, email, first_name, last_name, website, domain, phone")
      .eq("workspace_id", session.workspace.id)
      .in("validation_status", ["valid", "role_account"])
      .order("created_at", { ascending: false })
      .limit(300),
  ]);

  const mailboxes = (mailboxData ?? []) as ComposeMailbox[];
  const contacts = (contactData ?? []) as ComposeContact[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Compose</h1>
        <p className="hint mt-1">
          A single templated send. Multi-step sequences with follow-ups come from
          Campaigns.
        </p>
      </div>

      {mailboxes.length === 0 ? (
        <p className="card card-pad text-sm text-[var(--color-muted)]">
          No active mailbox yet.{" "}
          <Link className="text-[var(--color-brand)] hover:underline" href="/mailboxes">
            Connect one first
          </Link>
          .
        </p>
      ) : contacts.length === 0 ? (
        <p className="card card-pad text-sm text-[var(--color-muted)]">
          No validated contacts yet. Scrape some sites in{" "}
          <Link className="text-[var(--color-brand)] hover:underline" href="/prospecting">
            Prospecting
          </Link>{" "}
          and run validation.
        </p>
      ) : (
        <ComposeForm mailboxes={mailboxes} contacts={contacts} />
      )}
    </div>
  );
}
