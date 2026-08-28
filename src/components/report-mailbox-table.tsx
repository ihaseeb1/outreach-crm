"use client";

import { useState } from "react";

import {
  REPORT_MAILBOX_WINDOWS,
  countsFor,
  perDay,
  type MailboxVolume,
} from "@/mailboxes/volume";

export interface ReportMailboxRow {
  id: string;
  email: string;
  healthStatus: string;
  reputationScore: number | null;
  bounceRate: number | null;
  sentToday: number;
  dailyLimit: number;
}

/**
 * Sent volume per mailbox over 7 days to 3 months.
 *
 * One window for the whole table, switched at the top — the reason to look at
 * this table at all is to compare mailboxes, and that only works when they are
 * all reporting the same period. The counts for every window are computed on the
 * server in one pass (see summariseVolume) so switching is instant and costs no
 * round trip.
 *
 * Health, score and bounce rate are current values, not windowed: they describe
 * the mailbox now, and re-labelling them per window would be a lie.
 */
export function ReportMailboxTable({
  mailboxes,
  volumes,
}: {
  mailboxes: ReportMailboxRow[];
  /** mailbox id -> counts keyed by window length in days. */
  volumes: Record<string, MailboxVolume>;
}) {
  const [days, setDays] = useState<number>(30);

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Mailboxes</h2>
          <a
            className="text-xs text-[var(--color-brand)] hover:underline"
            href="/api/reports/export?type=mailboxes"
          >
            Export CSV
          </a>
        </div>
        <div
          className="inline-flex rounded-md border border-[var(--color-line)] bg-white p-0.5"
          role="group"
          aria-label="Sent volume window"
        >
          {REPORT_MAILBOX_WINDOWS.map((window) => (
            <button
              key={window.days}
              type="button"
              aria-pressed={days === window.days}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                days === window.days
                  ? "bg-[var(--color-brand)] text-white"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
              }`}
              onClick={() => setDays(window.days)}
            >
              {window.label}
            </button>
          ))}
        </div>
      </div>

      {mailboxes.length === 0 ? (
        <p className="px-5 py-6 text-sm text-[var(--color-muted)]">
          No mailboxes connected.
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Health</th>
                  <th>Score</th>
                  <th>Sent</th>
                  <th>Of which warmup</th>
                  <th>Per day</th>
                  <th>Bounce rate</th>
                  <th>Today</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => {
                  const counts = countsFor(volumes[mailbox.id], days);
                  const total = counts.outreach + counts.warmup;

                  return (
                    <tr key={mailbox.id}>
                      <td className="font-medium">{mailbox.email}</td>
                      <td>{mailbox.healthStatus}</td>
                      <td>
                        {mailbox.reputationScore === null
                          ? "—"
                          : `${mailbox.reputationScore}/100`}
                      </td>
                      <td>{total.toLocaleString()}</td>
                      <td>
                        {total === 0
                          ? "—"
                          : `${counts.warmup.toLocaleString()} (${Math.round(
                              (counts.warmup / total) * 100,
                            )}%)`}
                      </td>
                      <td>{perDay(total, days)}</td>
                      <td>
                        {mailbox.bounceRate === null
                          ? "—"
                          : `${(mailbox.bounceRate * 100).toFixed(1)}%`}
                      </td>
                      <td>
                        {mailbox.sentToday} / {mailbox.dailyLimit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="hint border-t border-[var(--color-line)] px-5 py-3">
            Sent totals include warmup, which spends the daily limit rather than
            adding to it — a mailbox capped at 6 a day sends six emails in total.
            Health, score and bounce rate are current, not windowed.
          </p>
        </>
      )}
    </section>
  );
}
