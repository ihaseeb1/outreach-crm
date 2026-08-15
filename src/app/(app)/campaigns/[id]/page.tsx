import Link from "next/link";
import { notFound } from "next/navigation";

import { CampaignControls } from "@/components/campaign-controls";
import { CampaignEnrollForm } from "@/components/campaign-enroll-form";
import { SequenceEditor, type EditableStep } from "@/components/sequence-editor";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { Campaign, SequenceStep } from "@/types/db";

export const dynamic = "force-dynamic";

const CONTACT_STATUS_STYLES: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  active: "bg-blue-50 text-[var(--color-brand)]",
  replied: "bg-green-50 text-[var(--color-ok)]",
  completed: "bg-gray-100 text-gray-700",
  bounced: "bg-red-50 text-[var(--color-danger)]",
  unsubscribed: "bg-amber-50 text-[var(--color-warn)]",
  paused: "bg-amber-50 text-[var(--color-warn)]",
  failed: "bg-red-50 text-[var(--color-danger)]",
};

interface EnrolledRow {
  id: string;
  current_step: number;
  status: string;
  next_send_at: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  contacts: { email: string; domain: string | null } | null;
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!campaignRow) notFound();
  const campaign = campaignRow as Campaign;

  const [{ data: stepRows }, { data: mailboxRows }, { data: enrolledRows }, { data: statRow }] =
    await Promise.all([
      supabase
        .from("sequence_steps")
        .select("*")
        .eq("campaign_id", id)
        .order("step_number", { ascending: true }),
      supabase
        .from("mailboxes")
        .select("id, email")
        .eq("workspace_id", session.workspace.id)
        .eq("is_active", true)
        .neq("health_status", "paused")
        .order("created_at", { ascending: true }),
      supabase
        .from("campaign_contacts")
        .select(
          "id, current_step, status, next_send_at, last_sent_at, last_error, contacts(email, domain)",
        )
        .eq("campaign_id", id)
        .order("next_send_at", { ascending: true, nullsFirst: false })
        .limit(100),
      supabase
        .from("campaign_stats")
        .select("*")
        .eq("campaign_id", id)
        .maybeSingle(),
    ]);

  const steps = (stepRows ?? []) as SequenceStep[];
  const editableSteps: EditableStep[] = steps.map((step) => ({
    delay_days: step.delay_days,
    subject_template: step.subject_template,
    body_template: step.body_template,
    reply_to_thread: step.reply_to_thread,
  }));

  const enrolled = (enrolledRows ?? []) as unknown as EnrolledRow[];
  const stat = (statRow ?? {}) as Record<string, number>;

  const summary = [
    { label: "Contacts", value: stat.total_contacts ?? 0 },
    { label: "In flight", value: (stat.pending ?? 0) + (stat.active ?? 0) },
    { label: "Replied", value: stat.replied ?? 0 },
    { label: "Completed", value: stat.completed ?? 0 },
    { label: "Bounced", value: stat.bounced ?? 0 },
    { label: "Opted out", value: stat.unsubscribed ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link className="hint hover:underline" href="/campaigns">
          ← Campaigns
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{campaign.name}</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {summary.map((item) => (
          <div key={item.label} className="card card-pad">
            <p className="hint">{item.label}</p>
            <p className="mt-1 text-xl font-semibold">{item.value}</p>
          </div>
        ))}
      </div>

      <CampaignControls
        campaignId={campaign.id}
        status={campaign.status}
        settings={campaign.settings}
        mailboxes={(mailboxRows ?? []) as { id: string; email: string }[]}
        selectedMailboxIds={
          Array.isArray(campaign.mailbox_ids) ? campaign.mailbox_ids : []
        }
      />

      <SequenceEditor campaignId={campaign.id} initialSteps={editableSteps} />

      <CampaignEnrollForm campaignId={campaign.id} />

      <section className="card">
        <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
          Enrolled contacts
        </h2>
        {enrolled.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            No contacts added yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Next send</th>
                  <th>Last sent</th>
                </tr>
              </thead>
              <tbody>
                {enrolled.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium">{row.contacts?.email ?? "—"}</td>
                    <td>
                      <span className={`badge ${CONTACT_STATUS_STYLES[row.status] ?? ""}`}>
                        {row.status}
                      </span>
                      {row.last_error && (
                        <span className="hint ml-2" title={row.last_error}>
                          {row.last_error.slice(0, 30)}
                        </span>
                      )}
                    </td>
                    <td>
                      {row.current_step} / {steps.length}
                    </td>
                    <td>
                      {row.next_send_at
                        ? new Date(row.next_send_at).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      {row.last_sent_at
                        ? new Date(row.last_sent_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
