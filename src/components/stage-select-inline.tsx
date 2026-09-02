"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { RelationshipStage } from "@/types/db";

/** The relationship pipeline stages, in order. */
export const STAGES: RelationshipStage[] = ["new", "contacted", "replied", "published", "won"];

/**
 * Inline pipeline-stage picker for a discovered site or active author. Posts the
 * change to /api/discovery/status and refreshes. Shared by both tables.
 */
export function StageSelect({
  entity,
  id,
  value,
}: {
  entity: "site" | "author";
  id: string;
  value: RelationshipStage;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<RelationshipStage>(value);
  const [busy, setBusy] = useState(false);

  async function change(next: RelationshipStage) {
    const previous = stage;
    setStage(next);
    setBusy(true);
    try {
      const response = await fetch("/api/discovery/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entity, id, status: next }),
      });
      if (!response.ok) throw new Error();
      router.refresh();
    } catch {
      setStage(previous); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      className="input py-1 text-xs"
      value={stage}
      disabled={busy}
      onChange={(e) => change(e.target.value as RelationshipStage)}
    >
      {STAGES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
