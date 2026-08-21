import Link from "next/link";

import { CampaignCreateForm } from "@/components/campaign-create-form";
import { CampaignDeleteButton } from "@/components/campaign-delete-button";
import { RunJobButton } from "@/components/run-job-button";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Campaign } from "@/types/db";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  active: "bg-green-50 text-[var(--color-ok)]",
  paused: "bg-amber-50 text-[var(--color-warn)]",
  completed: "bg-blue-50 text-[var(--color-brand)]",
  archived: "bg-gray-100 text-gray-500",
};

interface StatsRow {
  campaign_id: string;
  total_contacts: number;
  active: number;
  replied: number;
  completed: number;
  bounced: number;
  unsubscribed: number;
}

export default async function CampaignsPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const [{ data: campaignRows }, { data: statRows }] = await Promise.all([
    supabase
      .from("campaigns")
      .select("*")
      .eq("workspace_id", session.workspace.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("campaign_stats")
      .select("*")
      .eq("workspace_id", session.workspace.id),
  ]);

  const campaigns = (campaignRows ?? []) as Campaign[];
  const stats = new Map(
    ((statRows ?? []) as StatsRow[]).map((row) => [row.campaign_id, row]),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="hint mt-1">
          Multi-step sequences with automatic follow-ups, rotated across your
          mailboxes. A reply stops that contact's sequence immediately.
        </p>
      </div>

      <CampaignCreateForm />

      {campaigns.length === 0 ? (
        <p className="card card-pad text-sm text-[var(--color-muted)]">
          No campaigns yet.
        </p>
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Contacts</th>
                  <th>In flight</th>
                  <th>Replied</th>
                  <th>Bounced</th>
                  <th>Opted out</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => {
                  const stat = stats.get(campaign.id);
                  return (
                    <tr key={campaign.id}>
                      <td>
                        <Link
                          className="font-medium text-[var(--color-brand)] hover:underline"
                          href={`/campaigns/${campaign.id}`}
                        >
                          {campaign.name}
                        </Link>
                      </td>
                      <td>
                        <span className={`badge ${STATUS_STYLES[campaign.status] ?? ""}`}>
                          {campaign.status}
                        </span>
                      </td>
                      <td>{stat?.total_contacts ?? 0}</td>
                      <td>{stat?.active ?? 0}</td>
                      <td>{stat?.replied ?? 0}</td>
                      <td>{stat?.bounced ?? 0}</td>
                      <td>{stat?.unsubscribed ?? 0}</td>
                      <td className="text-right">
                        <CampaignDeleteButton
                          campaignId={campaign.id}
                          name={campaign.name}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="card card-pad space-y-3">
        <h2 className="text-sm font-semibold">Sending</h2>
        <p className="hint">
          Due steps go out on every cron tick, inside each campaign's sending
          window and within every mailbox's daily limit.
        </p>
        <RunJobButton job="campaigns" label="Send due steps now" limit={10} />
      </div>
    </div>
  );
}
