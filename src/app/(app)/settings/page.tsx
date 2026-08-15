import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

async function saveSettings(formData: FormData) {
  "use server";

  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const postalAddress = String(formData.get("postal_address") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  await supabase
    .from("workspaces")
    .update({
      sending_postal_address: postalAddress || null,
      ...(name ? { name } : {}),
    })
    .eq("id", session.workspace.id);

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "workspace.settings_updated",
    entityType: "workspace",
    entityId: session.workspace.id,
    meta: { postal_address_set: Boolean(postalAddress) },
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
}

export default async function SettingsPage() {
  const session = await requireSession();
  const appUrl = env.appUrl();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="hint mt-1">Workspace configuration and compliance.</p>
      </div>

      <form action={saveSettings} className="card card-pad space-y-4">
        <div>
          <label className="label" htmlFor="name">
            Workspace name
          </label>
          <input
            id="name"
            name="name"
            className="input"
            defaultValue={session.workspace.name}
          />
        </div>

        <div>
          <label className="label" htmlFor="postal_address">
            Sending postal address
          </label>
          <textarea
            id="postal_address"
            name="postal_address"
            className="input min-h-24"
            placeholder={"Your Company Ltd\n123 Example Street\nCity, Postcode\nCountry"}
            defaultValue={session.workspace.sending_postal_address ?? ""}
          />
          <p className="hint mt-1">
            Required by CAN-SPAM and appended to every campaign email. Campaigns
            are blocked from sending until this is filled in.
          </p>
        </div>

        <button className="btn-primary" type="submit">
          Save settings
        </button>
      </form>

      <section className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">External API key</h2>
        <p className="hint">
          Read-only access for your portal (used by <code>GET /api/deals</code> from
          phase 5). Send it as <code>Authorization: Bearer &lt;key&gt;</code>.
        </p>
        <code className="block overflow-x-auto rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs">
          {session.workspace.api_key}
        </code>
      </section>

      <section className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Background jobs</h2>
        <p className="hint">
          Every job is a bounded, idempotent batch. Point any scheduler at the tick
          endpoint every 5–10 minutes, sending{" "}
          <code>Authorization: Bearer $CRON_SECRET</code>.
        </p>
        <code className="block overflow-x-auto rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs">
          {appUrl}/api/cron/tick
        </code>
        <ul className="hint list-inside list-disc space-y-1">
          <li>
            <code>/api/cron/scrape</code> — scrape a batch of pending websites
          </li>
          <li>
            <code>/api/cron/validate</code> — validate a batch of contacts
          </li>
        </ul>
      </section>
    </div>
  );
}
