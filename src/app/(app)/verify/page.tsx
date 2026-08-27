import Link from "next/link";

import { EmailVerifier } from "@/components/email-verifier";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

async function countByStatus(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  workspaceId: string,
  statuses: string[],
): Promise<number> {
  const { count } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("validation_status", statuses);
  return count ?? 0;
}

export default async function VerifyPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();
  const workspaceId = session.workspace.id;

  const [sendable, undeliverable, pending, awaitingPower] = await Promise.all([
    countByStatus(supabase, workspaceId, ["valid", "safe", "role_account", "catch_all"]),
    countByStatus(supabase, workspaceId, [
      "invalid",
      "invalid_syntax",
      "no_mx",
      "disposable",
      "spamtrap",
      "disabled",
      "inbox_full",
    ]),
    countByStatus(supabase, workspaceId, ["unknown"]),
    supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .contains("meta", { needs_power: true })
      .then((r) => r.count ?? 0),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Email verifier</h1>
        <p className="hint mt-1">
          Your own in-house verifier — syntax, disposable, MX, role, free-provider
          and spam-trap checks, plus a real SMTP mailbox-existence and catch-all
          check in power mode. No third-party service; nothing leaves your
          infrastructure.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Sendable" value={sendable} tone="ok" />
        <Stat label="Removed / undeliverable" value={undeliverable} tone="danger" />
        <Stat label="Not yet checked" value={pending} tone="muted" />
      </div>

      <EmailVerifier />

      <div className="card card-pad space-y-2 text-sm">
        <h2 className="font-semibold">How verification runs on your list</h2>
        <ul className="hint list-inside list-disc space-y-1">
          <li>
            Imported and scraped contacts are quick-checked automatically. Anything
            undeliverable (bad syntax, dead domain, disposable, spam-trap) is
            removed from the list and added to your suppression list, so it can
            never be emailed or re-imported.
          </li>
          <li>
            Addresses that pass the quick check are queued for a deep power check —
            a real SMTP conversation that confirms the individual mailbox exists.
            {awaitingPower > 0 && ` ${awaitingPower} contact(s) are queued now.`}
          </li>
          <li>
            The power check needs outbound port 25, which the hosted app and the
            CI cron cannot use, so it runs from the verify worker on a box that
            allows it (a small VPS is the reliable choice):
          </li>
        </ul>
        <pre className="overflow-x-auto rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs">
          npx tsx scripts/verify-worker.ts
        </pre>
        <p className="hint">
          Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>SUPABASE_SERVICE_ROLE_KEY</code> in that shell first — the same two
          the scrape worker uses. Until it runs, quick-checked contacts stay
          sendable; running it further cuts bounces by dropping addresses whose
          mailbox does not exist.{" "}
          <Link className="text-[var(--color-brand)] hover:underline" href="/contacts?status=unknown">
            See unchecked contacts
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "danger" | "muted";
}) {
  const color =
    tone === "ok"
      ? "text-[var(--color-ok)]"
      : tone === "danger"
        ? "text-[var(--color-danger)]"
        : "text-[var(--color-muted)]";
  return (
    <div className="card card-pad">
      <p className="hint">{label}</p>
      <p className={`text-2xl font-semibold ${color}`}>{value.toLocaleString()}</p>
    </div>
  );
}
