import Link from "next/link";
import { notFound } from "next/navigation";

import { CampaignControls } from "@/components/campaign-controls";
import { CampaignDuplicateButton } from "@/components/campaign-duplicate-button";
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

/**
 * Enrolled contacts per page.
 *
 * The list used to be a bare `.limit(100)` with nothing to click, so a campaign
 * with 56 contacts looked complete and one with 400 silently showed a quarter of
 * itself. 50 keeps the page light enough to stay on one screen's worth of
 * scrolling.
 */
const PAGE_SIZE = 50;

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const requestedPage = Number(
    typeof query.page === "string" ? query.page : "1",
  );
  const page = Number.isFinite(requestedPage) && requestedPage > 0
    ? Math.floor(requestedPage)
    : 1;

  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", session.workspace.id)
    .maybeSingle();

  if (!campaignRow) notFound();
  const campaign = campaignRow as Campaign;

  const [
    { data: stepRows },
    { data: mailboxRows },
    { data: enrolledRows, count: enrolledCount },
    { data: statRow },
  ] = await Promise.all([
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
      // `count: exact` on the same query as the page slice, so "of 56" comes
      // from the table rather than from campaign_stats, which is a separate view
      // and can lag a just-finished enrolment.
      //
      // A second `.order("id")` breaks ties: hundreds of rows share the same
      // next_send_at (or share null), and Postgres is free to return equal rows
      // in any order it likes — which means the same contact can appear on both
      // page 1 and page 2 while another never appears at all.
      supabase
        .from("campaign_contacts")
        .select(
          "id, current_step, status, next_send_at, last_sent_at, last_error, contacts(email, domain)",
          { count: "exact" },
        )
        .eq("campaign_id", id)
        .order("next_send_at", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
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

  const total = enrolledCount ?? enrolled.length;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = (page - 1) * PAGE_SIZE + enrolled.length;
  const pageHref = (target: number) => `/campaigns/${id}?page=${target}`;

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link className="hint hover:underline" href="/campaigns">
            ← Campaigns
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{campaign.name}</h1>
        </div>
        <CampaignDuplicateButton campaignId={campaign.id} />
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

      <section className="card" id="enrolled">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="text-sm font-semibold">Enrolled contacts</h2>
          {total > 0 && (
            <p className="hint">
              {firstShown}–{lastShown} of {total.toLocaleString()}
            </p>
          )}
        </div>
        {enrolled.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
            {page > 1
              ? "Nothing on this page — the list is shorter than it was."
              : "No contacts added yet."}
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

        {lastPage > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-line)] px-5 py-3">
            <p className="hint">
              Page {page} of {lastPage}
            </p>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  className="btn-secondary px-2.5 py-1.5 text-xs"
                  href={`${pageHref(page - 1)}#enrolled`}
                >
                  ← Previous
                </Link>
              ) : (
                <span className="btn-secondary cursor-not-allowed px-2.5 py-1.5 text-xs opacity-50">
                  ← Previous
                </span>
              )}
              {page < lastPage ? (
                <Link
                  className="btn-secondary px-2.5 py-1.5 text-xs"
                  href={`${pageHref(page + 1)}#enrolled`}
                >
                  Next →
                </Link>
              ) : (
                <span className="btn-secondary cursor-not-allowed px-2.5 py-1.5 text-xs opacity-50">
                  Next →
                </span>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
