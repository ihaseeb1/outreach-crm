"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface WarmupState {
  enabled: boolean;
  current_daily_volume: number;
  target_daily_volume: number;
  ramp_increment: number;
  reply_rate: number;
}

const DEFAULTS: WarmupState = {
  enabled: false,
  current_daily_volume: 5,
  target_daily_volume: 40,
  ramp_increment: 2,
  reply_rate: 0.35,
};

export function WarmupControls({
  mailboxId,
  initial,
}: {
  mailboxId: string;
  initial: WarmupState | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<WarmupState>(initial ?? DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(patch: Partial<WarmupState>) {
    const next = { ...state, ...patch };
    setState(next);
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch("/api/warmup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mailbox_id: mailboxId, ...next }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Roll the toggle back so the UI does not claim warmup is on when it is not.
      if (patch.enabled !== undefined) setState(state);
    } finally {
      setBusy(false);
    }
  }

  const progress = Math.min(
    100,
    Math.round(
      (state.current_daily_volume / Math.max(1, state.target_daily_volume)) * 100,
    ),
  );

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={busy}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        Warmup {state.enabled ? "on" : "off"}
      </label>

      {state.enabled && (
        <>
          <div>
            <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
              <span>Ramp progress</span>
              <span>
                {state.current_daily_volume} → {state.target_daily_volume} /day
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-canvas)]">
              <div
                className="h-full rounded-full bg-[var(--color-ok)]"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="hint">Target/day</span>
              <input
                className="input px-2 py-1 text-sm"
                type="number"
                min={1}
                max={200}
                value={state.target_daily_volume}
                disabled={busy}
                onChange={(e) =>
                  setState({ ...state, target_daily_volume: Number(e.target.value) })
                }
                onBlur={() => save({})}
              />
            </label>
            <label className="block">
              <span className="hint">Ramp/day</span>
              <input
                className="input px-2 py-1 text-sm"
                type="number"
                min={1}
                max={10}
                value={state.ramp_increment}
                disabled={busy}
                onChange={(e) =>
                  setState({ ...state, ramp_increment: Number(e.target.value) })
                }
                onBlur={() => save({})}
              />
            </label>
            <label className="block">
              <span className="hint">Reply rate</span>
              <input
                className="input px-2 py-1 text-sm"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={state.reply_rate}
                disabled={busy}
                onChange={(e) =>
                  setState({ ...state, reply_rate: Number(e.target.value) })
                }
                onBlur={() => save({})}
              />
            </label>
          </div>
        </>
      )}

      {saved && <p className="hint text-[var(--color-ok)]">Saved.</p>}
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
