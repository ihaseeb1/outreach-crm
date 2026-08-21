import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import {
  TRACKING_LABELS,
  TRACKING_MODES,
  isTrackingMode,
  resolveTrackingMode,
} from "@/mail/tracking-summary";

export const dynamic = "force-dynamic";

async function saveSettings(formData: FormData) {
  "use server";

  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const postalAddress = String(formData.get("postal_address") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const tracking = String(formData.get("tracking") ?? "");

  // Merged, not replaced: `settings` is a shared jsonb column and writing a
  // fresh object here would silently drop anything else stored in it.
  const settings = {
    ...(session.workspace.settings ?? {}),
    ...(isTrackingMode(tracking) ? { tracking } : {}),
  };

  await supabase
    .from("workspaces")
    .update({
      sending_postal_address: postalAddress || null,
      settings,
      ...(name ? { name } : {}),
    })
    .eq("id", session.workspace.id);

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "workspace.settings_updated",
    entityType: "workspace",
    entityId: session.workspace.id,
    meta: {
      postal_address_set: Boolean(postalAddress),
      tracking: settings.tracking ?? null,
    },
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
}

export default async function SettingsPage() {
  const session = await requireSession();
  const appUrl = env.appUrl();
  const tracking = resolveTrackingMode(session.workspace.settings);

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

        <div>
          <label className="label" htmlFor="tracking">
            Open and click tracking
          </label>
          <select
            id="tracking"
            name="tracking"
            className="input"
            defaultValue={tracking}
          >
            {TRACKING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {TRACKING_LABELS[mode]}
              </option>
            ))}
          </select>
          <div className="hint mt-1 space-y-1">
            <p>
              Opens are recorded by a 1&times;1 image at the foot of the email,
              clicks by routing links through this app and on to where they were
              going. Both are per message, so a reply-less follow-up still shows
              whether step 2 was opened after step 1 was ignored.
            </p>
            <p>
              Two things worth knowing before leaving it on. Opens are
              approximate &mdash; a client that blocks images never registers
              one, and Apple Mail&rsquo;s privacy proxy fetches images before
              anyone has read anything, which reads as an open that did not
              happen. And a rewritten link points at{" "}
              <code>{appUrl}</code> rather than at the site itself, which some
              spam filters weigh against cold mail. <strong>Opens only</strong>{" "}
              keeps the signal and leaves the links alone.
            </p>
            <p>
              Warmup is never tracked whatever this says: it runs between your
              own mailboxes, so there is nothing to measure.
            </p>
          </div>
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
