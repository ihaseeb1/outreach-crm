"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface EditableStage {
  key: string;
  label: string;
  color: string;
  is_won: boolean;
  is_lost: boolean;
}

const COLORS = ["gray", "blue", "indigo", "amber", "green", "red"];

/** Add, rename, reorder and remove pipeline stages. */
export function PipelineEditor({ initial }: { initial: EditableStage[] }) {
  const router = useRouter();
  const [stages, setStages] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function update(index: number, patch: Partial<EditableStage>) {
    setStages((current) =>
      current.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
    );
  }

  function swap(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= stages.length) return;
    setStages((current) => {
      const next = [...current];
      const a = next[index]!;
      const b = next[target]!;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/pipeline", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stages }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      setMessage(
        payload.movedFrom?.length
          ? `Saved. Contacts in ${payload.movedFrom.join(", ")} were moved to the first stage.`
          : "Saved.",
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn-secondary" type="button" onClick={() => setOpen(true)}>
        Edit stages
      </button>
    );
  }

  return (
    <section className="card card-pad space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Pipeline stages</h2>
        <button className="hint hover:underline" type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      <div className="space-y-2">
        {stages.map((stage, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <input
              className="input w-32"
              value={stage.key}
              placeholder="key"
              onChange={(e) =>
                update(index, {
                  key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
                })
              }
            />
            <input
              className="input flex-1 min-w-32"
              value={stage.label}
              placeholder="Label"
              onChange={(e) => update(index, { label: e.target.value })}
            />
            <select
              className="input w-28"
              value={stage.color}
              onChange={(e) => update(index, { color: e.target.value })}
            >
              {COLORS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
            <label className="hint flex items-center gap-1">
              <input
                type="checkbox"
                checked={stage.is_won}
                onChange={(e) => update(index, { is_won: e.target.checked, is_lost: false })}
              />
              won
            </label>
            <label className="hint flex items-center gap-1">
              <input
                type="checkbox"
                checked={stage.is_lost}
                onChange={(e) => update(index, { is_lost: e.target.checked, is_won: false })}
              />
              lost
            </label>
            <button className="hint hover:underline" type="button" onClick={() => swap(index, -1)}>
              ↑
            </button>
            <button className="hint hover:underline" type="button" onClick={() => swap(index, 1)}>
              ↓
            </button>
            {stages.length > 1 && (
              <button
                className="hint text-[var(--color-danger)] hover:underline"
                type="button"
                onClick={() => setStages((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      <p className="hint">
        Removing a stage moves any contact sitting in it to the first stage, so
        nobody disappears off the board.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-secondary"
          type="button"
          disabled={stages.length >= 20}
          onClick={() =>
            setStages((current) => [
              ...current,
              { key: `stage_${current.length + 1}`, label: "New stage", color: "gray", is_won: false, is_lost: false },
            ])
          }
        >
          Add stage
        </button>
        <button className="btn-primary" type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save pipeline"}
        </button>
        {message && <span className="hint text-[var(--color-ok)]">{message}</span>}
        {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
      </div>
    </section>
  );
}
