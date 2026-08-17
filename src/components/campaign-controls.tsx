"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { TimezoneSelect } from "@/components/timezone-select";
import type { CampaignSettings, CampaignStatus } from "@/types/db";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 0–24, so the end can be midnight without wrapping to the previous day. */
const HOURS = Array.from({ length: 25 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  if (hour === 0) return "00:00 (midnight)";
  if (hour === 12) return "12:00 (noon)";
  if (hour === 24) return "24:00 (midnight)";
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(hour).padStart(2, "0")}:00 (${twelve}${suffix})`;
}

/**
 * Manual "send now". Separate from RunJobButton because it needs the
 * window override, which only a human-initiated run is allowed to set.
 */
function RunNowButton({
  campaignId,
  disabled,
}: {
  campaignId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: "campaigns", limit: 40, ignoreWindow: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Run failed.");
      const notes = Array.isArray(payload.notes) ? payload.notes.join(" · ") : "";
      setMessage(
        `Sent ${payload.sent}, skipped ${payload.skipped}, failed ${payload.failed}.${
          notes ? ` ${notes}` : ""
        }`,
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  void campaignId;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        className="btn-secondary"
        type="button"
        disabled={busy || disabled}
        onClick={() => void run()}
      >
        {busy ? "Sending…" : "Send first batch now"}
      </button>
      {message && <span className="hint">{message}</span>}
    </div>
  );
}

export function CampaignControls({
  campaignId,
  status,
  settings,
  mailboxes,
  selectedMailboxIds,
}: {
  campaignId: string;
  status: CampaignStatus;
  settings: CampaignSettings;
  mailboxes: { id: string; email: string }[];
  selectedMailboxIds: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rescheduled, setRescheduled] = useState<number | null>(null);

  const [startHour, setStartHour] = useState(settings.send_window_start ?? 9);
  const [endHour, setEndHour] = useState(settings.send_window_end ?? 17);
  const [days, setDays] = useState<number[]>(settings.send_days ?? [1, 2, 3, 4, 5]);
  const [timezone, setTimezone] = useState(settings.timezone ?? "UTC");
  const [selected, setSelected] = useState<string[]>(selectedMailboxIds);

  async function patch(body: Record<string, unknown>, thenRefresh = true) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: campaignId, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed.");
      setSaved(true);
      setRescheduled(
        typeof payload.rescheduled === "number" ? payload.rescheduled : null,
      );
      if (thenRefresh) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {status !== "active" ? (
          <button
            className="btn-primary"
            type="button"
            disabled={busy}
            onClick={() => patch({ status: "active" })}
          >
            {busy ? "…" : "Start sending"}
          </button>
        ) : (
          <button
            className="btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => patch({ status: "paused" })}
          >
            Pause
          </button>
        )}
        <span className="hint">
          Status: <strong>{status}</strong>
        </span>
      </div>

      <div className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
        <p className="text-sm font-medium">Send the first batch now</p>
        <p className="hint">
          Ignores the window for this one run and releases contacts that have
          never been emailed, so an overnight schedule does not mean waiting
          until overnight to test it. The schedule below is not changed, and
          follow-ups keep their normal spacing.
        </p>
        <RunNowButton campaignId={campaignId} disabled={status !== "active"} />
        {status !== "active" && (
          <p className="hint">Start sending first — a draft has nothing due.</p>
        )}
      </div>

      <div>
        <p className="label">Send from</p>
        {mailboxes.length === 0 ? (
          <p className="hint">No active mailboxes.</p>
        ) : (
          <div className="space-y-1">
            {mailboxes.map((mailbox) => (
              <label key={mailbox.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.length === 0 || selected.includes(mailbox.id)}
                  onChange={(e) => {
                    const base =
                      selected.length === 0 ? mailboxes.map((m) => m.id) : selected;
                    setSelected(
                      e.target.checked
                        ? [...new Set([...base, mailbox.id])]
                        : base.filter((id) => id !== mailbox.id),
                    );
                    setSaved(false);
                  }}
                />
                {mailbox.email}
              </label>
            ))}
            <p className="hint">
              First emails rotate across every ticked mailbox — the one with the
              most headroom left today goes next, so volume stays even instead of
              draining one inbox at a time. Each is capped by its own daily limit
              and spaced by a randomised gap.
            </p>
            <p className="hint">
              Follow-ups do <strong>not</strong> rotate. Once a contact has been
              emailed from a mailbox, every later step in the sequence goes from
              that same address and replies into the same thread, so the
              conversation reads as one exchange. If that mailbox is at its limit
              the follow-up waits rather than switching sender mid-conversation.
            </p>
          </div>
        )}
      </div>

      <div>
        <p className="label">Sending window</p>
        <p className="hint">
          Nothing leaves outside these hours on these days. Hours are 0–23 in the
          timezone below, so 9 to 17 means 9am–5pm. Sends are scattered randomly
          inside the window rather than fired on the hour.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="start-hour">
            Window start
          </label>
          <select
            id="start-hour"
            className="input"
            value={startHour}
            onChange={(e) => {
              setStartHour(Number(e.target.value));
              setSaved(false);
            }}
          >
            {HOURS.slice(0, 24).map((hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="end-hour">
            Window end
          </label>
          <select
            id="end-hour"
            className="input"
            value={endHour}
            onChange={(e) => {
              setEndHour(Number(e.target.value));
              setSaved(false);
            }}
          >
            {HOURS.slice(1).map((hour) => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="timezone">
            Timezone
          </label>
          <TimezoneSelect
            id="timezone"
            value={timezone}
            onChange={(next) => {
              setTimezone(next);
              setSaved(false);
            }}
          />
        </div>
      </div>

      {endHour <= startHour && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
          The window ends at or before it starts, which is an empty window. Saved
          as-is the campaign would fall back to 09:00–17:00 without telling you,
          so pick an end later than the start.
        </p>
      )}

      <div>
        <p className="label">Sending days</p>
        <div className="flex flex-wrap gap-2">
          {DAY_LABELS.map((label, day) => (
            <label key={label} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={days.includes(day)}
                onChange={(e) => {
                  setDays((current) =>
                    e.target.checked
                      ? [...current, day].sort()
                      : current.filter((d) => d !== day),
                  );
                  setSaved(false);
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-secondary"
          type="button"
          disabled={busy || endHour <= startHour}
          onClick={() =>
            patch({
              mailbox_ids:
                selected.length === mailboxes.length ? [] : selected,
              settings: {
                send_window_start: startHour,
                send_window_end: endHour,
                send_days: days,
                timezone,
              },
            })
          }
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
        {saved && (
          <span className="hint text-[var(--color-ok)]">
            Saved.
            {rescheduled !== null && rescheduled > 0 && (
              <> Moved {rescheduled} waiting contact(s) onto the new schedule.</>
            )}
          </span>
        )}
        {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
      </div>
    </section>
  );
}
