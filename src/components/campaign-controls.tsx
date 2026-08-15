"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CampaignSettings, CampaignStatus } from "@/types/db";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
              Sends rotate across every ticked mailbox, each capped by its own
              daily limit and spaced by a randomised gap.
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="start-hour">
            Window start
          </label>
          <input
            id="start-hour"
            className="input"
            type="number"
            min={0}
            max={23}
            value={startHour}
            onChange={(e) => {
              setStartHour(Number(e.target.value));
              setSaved(false);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="end-hour">
            Window end
          </label>
          <input
            id="end-hour"
            className="input"
            type="number"
            min={1}
            max={24}
            value={endHour}
            onChange={(e) => {
              setEndHour(Number(e.target.value));
              setSaved(false);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor="timezone">
            Timezone
          </label>
          <input
            id="timezone"
            className="input"
            placeholder="Europe/London"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              setSaved(false);
            }}
          />
        </div>
      </div>

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
          disabled={busy}
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
        {saved && <span className="hint text-[var(--color-ok)]">Saved.</span>}
        {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
      </div>
    </section>
  );
}
