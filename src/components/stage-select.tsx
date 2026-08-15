"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Inline pipeline-stage change from a contact record. */
export function StageSelect({
  contactId,
  value,
  stages,
}: {
  contactId: string;
  value: string;
  stages: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [stage, setStage] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    const previous = stage;
    setStage(next);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/contacts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: contactId, pipeline_stage: next }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "Could not change stage.");
      }
      router.refresh();
    } catch (err) {
      setStage(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <select
        className="input w-44"
        value={stage}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      >
        {stages.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
