"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Per-mailbox pacing: daily cap, and the gap this mailbox waits between two of
 * its own sends.
 *
 * The gap is a range, not a fixed number. A mailbox that sends exactly every
 * 120 minutes to the second looks like a machine; picking a random value in
 * [min, max] before each send is what makes the pattern human. Set both to the
 * same value if you genuinely want a fixed cadence.
 *
 * The gap is per mailbox, so it does not slow the campaign down overall — with
 * ten mailboxes on a 2-hour gap you still get ten sends every two hours, just
 * never two in a row from the same address.
 */

const PRESETS = [
  { label: "Fast (2–5 min)", min: 120, max: 300 },
  { label: "Steady (15–45 min)", min: 900, max: 2700 },
  { label: "Slow (1–2 h)", min: 3600, max: 7200 },
  { label: "Very slow (2–4 h)", min: 7200, max: 14_400 },
];

function toMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

export function MailboxPacing({
  id,
  dailyLimit,
  minGapSeconds,
  maxGapSeconds,
}: {
  id: string;
  dailyLimit: number;
  minGapSeconds: number;
  maxGapSeconds: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(dailyLimit);
  const [minMinutes, setMinMinutes] = useState(toMinutes(minGapSeconds));
  const [maxMinutes, setMaxMinutes] = useState(toMinutes(maxGapSeconds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (maxMinutes < minMinutes) {
      setError("The longest gap must be at least the shortest gap.");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/mailboxes", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          daily_limit: limit,
          min_gap_seconds: Math.max(10, minMinutes * 60),
          max_gap_seconds: Math.max(10, maxMinutes * 60),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const summary =
    minGapSeconds === maxGapSeconds
      ? `every ${toMinutes(minGapSeconds)} min`
      : `${toMinutes(minGapSeconds)}–${toMinutes(maxGapSeconds)} min apart`;

  if (!open) {
    return (
      <button
        className="text-xs text-[var(--color-brand)] hover:underline"
        type="button"
        onClick={() => setOpen(true)}
      >
        Pacing: {dailyLimit}/day, {summary} — edit
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--color-line)] p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">Pacing</p>
        <button
          className="hint hover:underline"
          type="button"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="label text-xs" htmlFor={`limit-${id}`}>
            Emails per day
          </label>
          <input
            id={`limit-${id}`}
            className="input"
            type="number"
            min={1}
            max={2000}
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setSaved(false);
            }}
          />
        </div>
        <div>
          <label className="label text-xs" htmlFor={`min-${id}`}>
            Shortest gap (min)
          </label>
          <input
            id={`min-${id}`}
            className="input"
            type="number"
            min={1}
            max={1440}
            value={minMinutes}
            onChange={(e) => {
              setMinMinutes(Number(e.target.value));
              setSaved(false);
            }}
          />
        </div>
        <div>
          <label className="label text-xs" htmlFor={`max-${id}`}>
            Longest gap (min)
          </label>
          <input
            id={`max-${id}`}
            className="input"
            type="number"
            min={1}
            max={1440}
            value={maxMinutes}
            onChange={(e) => {
              setMaxMinutes(Number(e.target.value));
              setSaved(false);
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="btn-secondary px-2 py-1 text-xs"
            type="button"
            onClick={() => {
              setMinMinutes(toMinutes(preset.min));
              setMaxMinutes(toMinutes(preset.max));
              setSaved(false);
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <p className="hint text-xs">
        This mailbox waits a random time between the two values after each send,
        so it never fires twice in a row on the same beat. Other mailboxes keep
        sending meanwhile — the gap paces one address, not the campaign.
      </p>

      <div className="flex items-center gap-3">
        <button
          className="btn-primary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save pacing"}
        </button>
        {saved && <span className="text-xs text-[var(--color-ok)]">Saved.</span>}
        {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
      </div>
    </div>
  );
}
