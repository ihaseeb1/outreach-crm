"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface BoardStage {
  key: string;
  label: string;
  color: string;
}

export interface BoardCard {
  id: string;
  email: string;
  domain: string | null;
  name: string | null;
  pipeline_stage: string;
  last_message_at: string | null;
  has_deal: boolean;
}

const COLOR_STYLES: Record<string, string> = {
  gray: "bg-gray-100 text-gray-700",
  blue: "bg-blue-50 text-[var(--color-brand)]",
  indigo: "bg-indigo-50 text-indigo-700",
  amber: "bg-amber-50 text-[var(--color-warn)]",
  green: "bg-green-50 text-[var(--color-ok)]",
  red: "bg-red-50 text-[var(--color-danger)]",
};

/**
 * Drag-and-drop pipeline board using native HTML5 drag events — no dependency,
 * and it degrades to the per-card stage dropdown on touch devices where HTML5
 * drag is not supported.
 */
export function PipelineBoard({
  stages,
  cards,
}: {
  stages: BoardStage[];
  cards: BoardCard[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(cards);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function move(contactId: string, stage: string) {
    const previous = items;
    // Optimistic: the card jumps immediately, and rolls back if the save fails.
    setItems((current) =>
      current.map((card) =>
        card.id === contactId ? { ...card, pipeline_stage: stage } : card,
      ),
    );
    setError(null);

    try {
      const response = await fetch("/api/contacts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: contactId, pipeline_stage: stage }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "Could not move the contact.");
      }
      router.refresh();
    } catch (err) {
      setItems(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {stages.map((stage) => {
          const stageCards = items.filter(
            (card) => card.pipeline_stage === stage.key,
          );

          return (
            <div
              key={stage.key}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(stage.key);
              }}
              onDragLeave={() => setOver((current) => (current === stage.key ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                if (dragging) void move(dragging, stage.key);
                setDragging(null);
              }}
              className={`w-64 shrink-0 rounded-lg border p-2 transition-colors ${
                over === stage.key
                  ? "border-[var(--color-brand)] bg-blue-50/40"
                  : "border-[var(--color-line)] bg-[var(--color-surface)]"
              }`}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className={`badge ${COLOR_STYLES[stage.color] ?? COLOR_STYLES.gray}`}>
                  {stage.label}
                </span>
                <span className="hint">{stageCards.length}</span>
              </div>

              <div className="space-y-2">
                {stageCards.map((card) => (
                  <article
                    key={card.id}
                    draggable
                    onDragStart={() => setDragging(card.id)}
                    onDragEnd={() => setDragging(null)}
                    className={`cursor-grab rounded-md border border-[var(--color-line)] bg-white p-2.5 text-sm active:cursor-grabbing ${
                      dragging === card.id ? "opacity-50" : ""
                    }`}
                  >
                    <Link
                      className="block truncate font-medium text-[var(--color-brand)] hover:underline"
                      href={`/contacts/${card.id}`}
                    >
                      {card.email}
                    </Link>
                    <p className="truncate text-xs text-[var(--color-muted)]">
                      {card.name || card.domain || "—"}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="hint">
                        {card.last_message_at
                          ? new Date(card.last_message_at).toLocaleDateString()
                          : "no contact yet"}
                      </span>
                      {card.has_deal && (
                        <span className="badge bg-green-50 text-[var(--color-ok)]">
                          deal
                        </span>
                      )}
                    </div>

                    {/* Touch fallback — HTML5 drag does not fire on mobile. */}
                    <select
                      className="mt-2 w-full rounded border border-[var(--color-line)] px-1 py-0.5 text-xs md:hidden"
                      value={card.pipeline_stage}
                      onChange={(e) => void move(card.id, e.target.value)}
                    >
                      {stages.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </article>
                ))}

                {stageCards.length === 0 && (
                  <p className="px-1 py-4 text-center text-xs text-[var(--color-muted)]">
                    Drop here
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
