"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Warmup cleanup panel (Mailboxes page).
 *
 * Shows how many warmup emails are live vs already cleaned, lets an admin pick a
 * retention (today / 7 days / 14 days), turn auto-deletion on or off, preview,
 * and run a cleanup on the existing backlog now. Deletion only ever removes
 * warmup that is past retention and pool-to-pool; the server re-checks both.
 */

type Retention = "today" | "7d" | "14d";

const RETENTIONS: { value: Retention; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "14d", label: "14 days" },
];

export interface WarmupCleanupProps {
  canManage: boolean;
  enabled: boolean;
  retention: Retention;
  live: number;
  softDeleted: number;
  recent: { action: string; count: number | null; at: string | null }[];
}

interface RunResult {
  dryRun: boolean;
  softDeleted: number;
  hardDeleted: number;
  mailboxTrashed: number;
  mailboxesPurged: number;
  aborted?: string[];
  skipped?: string[];
}

export function WarmupCleanup(props: WarmupCleanupProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  async function call(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setMessage(null);
    try {
      const response = await fetch("/api/warmup/deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed (HTTP ${response.status}).`);
      }
      return payload;
    } finally {
      setBusy(null);
    }
  }

  async function setRetention(value: Retention) {
    try {
      await call({ action: "configure", deleteAfter: value }, `ret-${value}`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggle() {
    try {
      await call({ action: "configure", enabled: !props.enabled }, "toggle");
      setMessage(props.enabled ? "Auto-deletion turned off." : "Auto-deletion turned on.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function run(dryRun: boolean) {
    setResult(null);
    try {
      const payload = (await call({ action: "run", dryRun }, dryRun ? "preview" : "run")) as RunResult;
      setResult(payload);
      if (!dryRun) router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="card card-pad space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Warmup cleanup</h2>
          <p className="hint mt-1 max-w-xl">
            Automatically deletes old warmup emails — the ones your own accounts
            send each other. Real replies from publishers are never touched. Mail
            is moved to Trash (recoverable ~30 days), not erased.
          </p>
        </div>
        <span
          className={
            props.enabled
              ? "rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-[var(--color-ok)]"
              : "rounded-full bg-[var(--color-canvas)] px-2.5 py-1 text-xs font-medium text-[var(--color-muted)]"
          }
        >
          {props.enabled ? "On" : "Off"}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Warmup emails" value={props.live} hint="tagged, still live" />
        <Stat label="Cleaned up" value={props.softDeleted} hint="deleted / in Trash" />
        <Stat
          label="Retention"
          value={RETENTIONS.find((r) => r.value === props.retention)?.label ?? props.retention}
          hint="older than this is deleted"
        />
      </div>

      {!props.canManage ? (
        <p className="hint">Only an admin can change these settings.</p>
      ) : (
        <>
          {/* Retention selector */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-[var(--color-muted)]">
              Delete warmups older than
            </p>
            <div className="flex flex-wrap gap-2">
              {RETENTIONS.map((option) => {
                const active = props.retention === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setRetention(option.value)}
                    disabled={busy !== null}
                    className={
                      active
                        ? "rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-sm font-medium text-[var(--color-surface)]"
                        : "btn-secondary"
                    }
                    aria-pressed={active}
                  >
                    {busy === `ret-${option.value}` ? "Saving…" : option.label}
                  </button>
                );
              })}
            </div>
            <p className="hint">
              {props.retention === "today"
                ? "A warmup is deleted at the end of the day it was sent."
                : `A warmup is deleted once it is older than ${props.retention === "7d" ? "7 days" : "14 days"}.`}
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
            <button type="button" className="btn-secondary" onClick={toggle} disabled={busy !== null}>
              {busy === "toggle"
                ? "Saving…"
                : props.enabled
                  ? "Turn off auto-deletion"
                  : "Turn on auto-deletion"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => run(true)}
              disabled={busy !== null}
            >
              {busy === "preview" ? "Checking…" : "Preview"}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => run(false)}
              disabled={busy !== null || !props.enabled}
              title={props.enabled ? undefined : "Turn on auto-deletion first"}
            >
              {busy === "run" ? "Cleaning…" : "Clean up now"}
            </button>
          </div>

          {!props.enabled && (
            <p className="hint">
              Turn on auto-deletion to clean up now and on the daily schedule.
              Preview works either way and never deletes anything.
            </p>
          )}
        </>
      )}

      {message && <p className="text-sm text-[var(--color-ink)]">{message}</p>}

      {result && (
        <div className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-sm">
          <p className="font-medium">
            {result.dryRun ? "Preview — nothing was deleted" : "Cleanup run"}
          </p>
          <p className="hint mt-0.5">
            {result.dryRun ? "Would delete" : "Deleted"} {result.softDeleted} from the
            database{!result.dryRun && result.mailboxTrashed > 0
              ? `, moved ${result.mailboxTrashed} to Trash across ${result.mailboxesPurged} mailbox(es)`
              : ""}
            {result.hardDeleted > 0 ? `, ${result.hardDeleted} permanently removed after grace` : ""}.
          </p>
          {result.aborted && result.aborted.length > 0 && (
            <p className="mt-1 text-xs text-[var(--color-danger)]">
              Aborted: {result.aborted.join(" · ")}
            </p>
          )}
          {result.skipped && result.skipped.length > 0 && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">{result.skipped.join(" · ")}</p>
          )}
        </div>
      )}

      {/* Recent activity */}
      {props.recent.length > 0 && (
        <div className="space-y-1.5 border-t border-[var(--color-border)] pt-3">
          <p className="text-xs font-medium text-[var(--color-muted)]">Recent cleanups</p>
          <ul className="space-y-1 text-xs text-[var(--color-muted)]">
            {props.recent.map((row, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span>
                  {describeAction(row.action)}
                  {row.count != null ? ` — ${row.count}` : ""}
                </span>
                <span>{row.at ? new Date(row.at).toLocaleString() : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint: string;
}) {
  return (
    <div className="rounded-md bg-[var(--color-canvas)] px-3 py-2">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs font-medium text-[var(--color-ink)]">{label}</p>
      <p className="text-[11px] text-[var(--color-muted)]">{hint}</p>
    </div>
  );
}

function describeAction(action: string): string {
  switch (action) {
    case "warmup.soft_deleted":
      return "Deleted from database";
    case "warmup.hard_deleted":
      return "Permanently removed";
    case "warmup.mailbox_trashed":
      return "Moved to Trash";
    case "warmup.deletion_enabled":
      return "Auto-deletion turned on";
    case "warmup.deletion_disabled":
      return "Auto-deletion turned off";
    case "warmup.purge_aborted":
      return "Cleanup aborted (safety)";
    case "warmup.purge_anomaly":
      return "Anomaly skipped (safety)";
    default:
      return action.replace(/^warmup\./, "").replace(/_/g, " ");
  }
}
