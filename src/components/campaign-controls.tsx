"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { TimezoneSelect } from "@/components/timezone-select";
import { DEFAULT_TIMEZONE } from "@/lib/datetime";
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

/**
 * Force any stalled follow-ups through. Reactivates enrolments stuck on `failed`
 * (that have not replied / bounced / opted out), clears expired claim locks,
 * makes every overdue step due now, and sends ignoring the window — for when a
 * follow-up "got stuck" and you want it to go on time rather than wait for the
 * next tick.
 */
function PushFollowupsButton({
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
        body: JSON.stringify({ job: "campaigns", campaignId, release: true, limit: 40 }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Run failed.");
      const notes = Array.isArray(payload.notes) ? payload.notes.join(" · ") : "";
      setMessage(
        `Revived ${payload.reactivated ?? 0} stuck, sent ${payload.sent}, ` +
          `skipped ${payload.skipped}, failed ${payload.failed}.${notes ? ` ${notes}` : ""}`,
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        className="btn-secondary"
        type="button"
        disabled={busy || disabled}
        onClick={() => void run()}
      >
        {busy ? "Pushing…" : "Push stuck follow-ups now"}
      </button>
      {message && <span className="hint">{message}</span>}
    </div>
  );
}

/**
 * Milliseconds the wall clock in `timeZone` is ahead of UTC at `date`.
 * Positive east of Greenwich.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const get = (type: string) =>
    dtf.formatToParts(date).find((part) => part.type === type)?.value ?? "";
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) % 24,
    Number(get("minute")),
    Number(get("second")),
  );
  return asUtc - date.getTime();
}

/**
 * Interprets a datetime-local value ("YYYY-MM-DDTHH:MM") as wall-clock time in
 * `timeZone` and returns the matching UTC instant. Two passes so a DST change
 * between "now" and the target does not skew the result by an hour.
 */
function zonedInputToUtc(input: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  let utc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 2; i++) {
    utc = new Date(Date.UTC(y, mo - 1, d, h, mi) - tzOffsetMs(utc, timeZone));
  }
  return utc;
}

/** ISO UTC instant -> "20 Oct 2026, 9:00 AM" rendered in `timeZone`. */
function formatZoned(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return iso;
  }
}

/** Default schedule input: tomorrow 09:00, wall-clock in `timeZone`. */
function defaultScheduleInput(timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const get = (type: string) =>
    dtf.formatToParts(new Date()).find((part) => part.type === type)?.value ?? "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const tomorrow = new Date(
    Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + 1),
  );
  return `${tomorrow.getUTCFullYear()}-${pad(tomorrow.getUTCMonth() + 1)}-${pad(
    tomorrow.getUTCDate(),
  )}T09:00`;
}

export function CampaignControls({
  campaignId,
  status,
  settings,
  mailboxes,
  selectedMailboxIds,
  scheduledActivateAt,
}: {
  campaignId: string;
  status: CampaignStatus;
  settings: CampaignSettings;
  mailboxes: { id: string; email: string }[];
  selectedMailboxIds: string[];
  scheduledActivateAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rescheduled, setRescheduled] = useState<number | null>(null);

  const [startHour, setStartHour] = useState(settings.send_window_start ?? 1);
  const [endHour, setEndHour] = useState(settings.send_window_end ?? 24);
  const [days, setDays] = useState<number[]>(settings.send_days ?? [1, 2, 3, 4, 5]);
  const [timezone, setTimezone] = useState(settings.timezone ?? DEFAULT_TIMEZONE);
  const [selected, setSelected] = useState<string[]>(selectedMailboxIds);
  const [scheduleInput, setScheduleInput] = useState(() =>
    defaultScheduleInput(settings.timezone ?? DEFAULT_TIMEZONE),
  );

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

      {(status === "draft" || status === "paused") && (
        <div className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
          <p className="text-sm font-medium">Schedule activation</p>
          {scheduledActivateAt ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="hint">
                Starts automatically on{" "}
                <strong>{formatZoned(scheduledActivateAt, timezone)}</strong>{" "}
                ({timezone}).
              </span>
              <button
                className="btn-secondary"
                type="button"
                disabled={busy}
                onClick={() => patch({ scheduled_activate_at: null })}
              >
                {busy ? "…" : "Cancel schedule"}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="label" htmlFor="schedule-at">
                  Start at ({timezone})
                </label>
                <input
                  id="schedule-at"
                  type="datetime-local"
                  className="input"
                  value={scheduleInput}
                  onChange={(e) => setScheduleInput(e.target.value)}
                />
              </div>
              <button
                className="btn-secondary"
                type="button"
                disabled={busy || !scheduleInput}
                onClick={() => {
                  const utc = zonedInputToUtc(scheduleInput, timezone);
                  if (!utc) {
                    setError("Pick a valid date and time.");
                    return;
                  }
                  patch({ scheduled_activate_at: utc.toISOString() });
                }}
              >
                {busy ? "Scheduling…" : "Schedule"}
              </button>
            </div>
          )}
          <p className="hint">
            The campaign activates itself at that time and starts sending inside
            its normal window. The sending window and days above are not
            changed.
          </p>
        </div>
      )}

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

      <div className="space-y-2 rounded-md border border-[var(--color-line)] p-3">
        <p className="text-sm font-medium">Follow-ups stuck?</p>
        <p className="hint">
          Pushes any stalled follow-ups through now: revives contacts stuck on a
          failed step (unless they replied, bounced or opted out), clears expired
          locks, and sends everything overdue ignoring the window. Use this if a
          scheduled follow-up did not go out on time.
        </p>
        <PushFollowupsButton campaignId={campaignId} disabled={status !== "active"} />
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
              and spaced by a randomised gap. Fully-healthy mailboxes are used
              first; a mailbox in poor health is left to warm up and only sends
              outreach if no healthy one has room.
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
