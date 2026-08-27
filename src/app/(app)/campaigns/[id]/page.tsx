import Link from "next/link";
import { notFound } from "next/navigation";

import { CampaignAdmin } from "@/components/campaign-admin";
import { CampaignControls } from "@/components/campaign-controls";
import { CampaignDuplicateButton } from "@/components/campaign-duplicate-button";
import { CampaignEnrollForm } from "@/components/campaign-enroll-form";
import { CampaignPurgeButton } from "@/components/campaign-purge-button";
import { SequenceEditor, type EditableStep } from "@/components/sequence-editor";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { blockerReason } from "@/campaigns/blockers";
import { resolveWindow } from "@/campaigns/schedule";
import { fmtDateTime } from "@/lib/datetime";
import {
  readTracking,
  rollUpTracking,
  type TrackingSummary,
} from "@/mail/tracking-summary";
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
  contact_id: string;
  current_step: number;
  status: string;
  next_send_at: string | null;
  last_sent_at: string | null;
  last_error: string | null;
  paused_reason: string | null;
  contacts: {
    email: string;
    domain: string | null;
    validation_status: string | null;
  } | null;
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
    { data: sentRows },
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
          "id, contact_id, current_step, status, next_send_at, last_sent_at, last_error, paused_reason, contacts(email, domain, validation_status)",
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
      // Every email this campaign has sent, for the open/click figures. One
      // query rather than one per row: at seven steps a campaign of 500
      // contacts is 3,500 rows at most, and both the per-step summary and the
      // per-contact columns are counted from the same read, so they cannot
      // disagree.
      supabase
        .from("messages")
        .select("contact_id, step_number, meta")
        .eq("campaign_id", id)
        .eq("direction", "outbound")
        .eq("status", "sent")
        .limit(20_000),
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

  // "Why isn't this sending?" — computed per row from the data already loaded,
  // plus a single suppression lookup over the addresses on this page.
  const now = new Date();
  const window = resolveWindow(campaign.settings);
  const stepNumbers = new Set(steps.map((step) => step.step_number));
  const activeMailboxIds = new Set(
    ((mailboxRows ?? []) as { id: string }[]).map((mailbox) => mailbox.id),
  );
  const campaignMailboxIds = Array.isArray(campaign.mailbox_ids)
    ? campaign.mailbox_ids
    : [];
  const hasActiveMailbox =
    campaignMailboxIds.length === 0
      ? activeMailboxIds.size > 0
      : campaignMailboxIds.some((mid) => activeMailboxIds.has(mid));

  const pageEmails = enrolled
    .map((row) => row.contacts?.email)
    .filter((email): email is string => Boolean(email));
  const { data: supRows } = pageEmails.length
    ? await supabase
        .from("suppressions")
        .select("email")
        .eq("workspace_id", session.workspace.id)
        .in("email", pageEmails)
    : { data: [] as { email: string }[] };
  const suppressed = new Set(
    ((supRows ?? []) as { email: string }[]).map((row) => row.email),
  );

  const blockerByRow = new Map<string, ReturnType<typeof blockerReason>>();
  for (const row of enrolled) {
    blockerByRow.set(
      row.id,
      blockerReason({
        status: row.status,
        currentStep: row.current_step,
        nextSendAt: row.next_send_at,
        lastError: row.last_error,
        pausedReason: row.paused_reason,
        validationStatus: row.contacts?.validation_status ?? null,
        suppressed: row.contacts?.email
          ? suppressed.has(row.contacts.email)
          : false,
        campaignStatus: campaign.status,
        hasSequenceStep: stepNumbers.has(row.current_step + 1),
        hasActiveMailbox,
        now,
        window,
      }),
    );
  }
  const blockedOnPage = [...blockerByRow.values()].filter(Boolean).length;

  // Tracking, bucketed two ways from one read.
  const trackingByContact = new Map<string, TrackingSummary[]>();
  const trackingByStep = new Map<number, TrackingSummary[]>();

  for (const row of (sentRows ?? []) as {
    contact_id: string | null;
    step_number: number | null;
    meta: Record<string, unknown> | null;
  }[]) {
    const summary = readTracking(row.meta);
    if (!summary) continue;
    if (row.contact_id) {
      const list = trackingByContact.get(row.contact_id) ?? [];
      list.push(summary);
      trackingByContact.set(row.contact_id, list);
    }
    const step = row.step_number ?? 0;
    const byStep = trackingByStep.get(step) ?? [];
    byStep.push(summary);
    trackingByStep.set(step, byStep);
  }

  const stepEngagement = [...trackingByStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, summaries]) => ({
      step,
      sent: summaries.length,
      ...rollUpTracking(summaries),
      // People, not events: five opens by one publisher is not five publishers.
      openers: summaries.filter((summary) => summary.opens > 0).length,
      clickers: summaries.filter((summary) => summary.clicks > 0).length,
    }));

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

      {stepEngagement.length > 0 && (
        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-line)] px-5 py-3">
            <h2 className="text-sm font-semibold">Opens and clicks by step</h2>
            <p className="hint">
              Counted per email sent. Opens are approximate — images blocked
              means no open recorded, and a privacy proxy can fetch the image
              before anyone reads it.
            </p>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Sent</th>
                  <th>Opened</th>
                  <th>Clicked</th>
                </tr>
              </thead>
              <tbody>
                {stepEngagement.map((row) => (
                  <tr key={row.step}>
                    <td className="font-medium">
                      {row.step === 0 ? "One-off" : `Step ${row.step}`}
                    </td>
                    <td>{row.sent}</td>
                    <td>
                      {row.openers}
                      <span className="hint">
                        {" "}
                        ({Math.round((row.openers / Math.max(1, row.sent)) * 100)}%
                        {row.opens > row.openers && `, ${row.opens} opens`})
                      </span>
                    </td>
                    <td>
                      {row.clickers}
                      {row.clicks > row.clickers && (
                        <span className="hint"> ({row.clicks} clicks)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <CampaignControls
        campaignId={campaign.id}
        status={campaign.status}
        settings={campaign.settings}
        mailboxes={(mailboxRows ?? []) as { id: string; email: string }[]}
        selectedMailboxIds={
          Array.isArray(campaign.mailbox_ids) ? campaign.mailbox_ids : []
        }
      />

      <CampaignAdmin
        campaignId={campaign.id}
        name={campaign.name}
        status={campaign.status}
      />

      <SequenceEditor campaignId={campaign.id} initialSteps={editableSteps} />

      <CampaignEnrollForm campaignId={campaign.id} />

      <section className="card" id="enrolled">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-line)] px-5 py-3">
          <h2 className="text-sm font-semibold">Enrolled contacts</h2>
          <div className="flex flex-wrap items-center gap-3">
            {blockedOnPage > 0 && (
              <span
                className="badge bg-amber-50 text-[var(--color-warn)]"
                title="Contacts on this page that are not sending — see the Not sending column for why."
              >
                {blockedOnPage} not sending
              </span>
            )}
            {total > 0 && (
              <p className="hint">
                {firstShown}–{lastShown} of {total.toLocaleString()}
              </p>
            )}
            <CampaignPurgeButton campaignId={campaign.id} />
          </div>
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
                  <th>Opened</th>
                  <th>Next send</th>
                  <th>Last sent</th>
                  <th>Not sending</th>
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
                      {(() => {
                        const summaries = trackingByContact.get(row.contact_id) ?? [];
                        if (summaries.length === 0) return <span className="hint">—</span>;
                        const rolled = rollUpTracking(summaries);
                        if (!rolled.openedAny) {
                          return <span className="hint">not yet</span>;
                        }
                        return (
                          <span
                            className="text-[var(--color-ok)]"
                            title={
                              rolled.firstOpenAt
                                ? `First opened ${fmtDateTime(rolled.firstOpenAt)}`
                                : undefined
                            }
                          >
                            {rolled.opens}×
                            {rolled.clickedAny && ` · ${rolled.clicks} click${rolled.clicks === 1 ? "" : "s"}`}
                          </span>
                        );
                      })()}
                    </td>
                    <td>{fmtDateTime(row.next_send_at)}</td>
                    <td>{fmtDateTime(row.last_sent_at)}</td>
                    <td>
                      {(() => {
                        const blocker = blockerByRow.get(row.id);
                        if (blocker) {
                          return (
                            <span
                              className="text-[var(--color-warn)]"
                              title={blocker.reason}
                            >
                              {blocker.reason}
                            </span>
                          );
                        }
                        if (row.status === "pending" || row.status === "active") {
                          return (
                            <span className="text-[var(--color-ok)]">
                              sending soon
                            </span>
                          );
                        }
                        return <span className="hint">—</span>;
                      })()}
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
