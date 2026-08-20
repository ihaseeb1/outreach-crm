"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

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

/** One column (w-64 = 256px) plus the gap-3 between them. */
const COLUMN_STEP = 268;

/** How close to an edge a drag has to get before the board scrolls itself. */
const EDGE_ZONE_PX = 90;
const EDGE_STEP_PX = 18;

/**
 * Drag-and-drop pipeline board using native HTML5 drag events — no dependency,
 * and it degrades to the per-card stage dropdown on touch devices where HTML5
 * drag is not supported.
 *
 * The board is its own scroll region rather than growing with the page, and that
 * is the whole point of the layout: with a tall column the page used to scroll
 * away from the stage headings, so once you were far enough down and far enough
 * right there was nothing on screen saying which column you were looking at.
 * Bounding the height means the headings can be `sticky` and the horizontal
 * scrollbar stays where you can reach it.
 *
 * Three ways to reach a column off to the right, because dragging alone was not
 * enough: the arrow buttons, the stage chips above the board, and the board
 * scrolling itself when a drag nears an edge.
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

  const scroller = useRef<HTMLDivElement | null>(null);
  const columns = useRef<Record<string, HTMLDivElement | null>>({});
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  /** -1 scrolling left, 1 scrolling right, 0 not scrolling. */
  const [edge, setEdge] = useState(0);

  const syncEdges = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    setAtStart(element.scrollLeft <= 2);
    // A 2px slack: fractional device-pixel widths mean scrollLeft rarely lands
    // exactly on the maximum, which would leave the button enabled forever.
    setAtEnd(element.scrollLeft >= max - 2);
  }, []);

  useEffect(() => {
    syncEdges();
    window.addEventListener("resize", syncEdges);
    return () => window.removeEventListener("resize", syncEdges);
  }, [syncEdges, stages.length]);

  // Auto-scroll while a card is held near an edge. An interval rather than
  // reacting to dragover alone: dragover stops firing when the pointer holds
  // still, which is exactly what someone does when waiting for the board to
  // come to them.
  useEffect(() => {
    if (edge === 0) return;
    const timer = window.setInterval(() => {
      scroller.current?.scrollBy({ left: edge * EDGE_STEP_PX });
    }, 16);
    return () => window.clearInterval(timer);
  }, [edge]);

  function scrollByColumn(direction: -1 | 1) {
    scroller.current?.scrollBy({
      left: direction * COLUMN_STEP,
      behavior: "smooth",
    });
  }

  /**
   * Brings a stage's column to the left edge.
   *
   * Deliberately not `scrollIntoView` — that walks up every ancestor and would
   * scroll the page as well as the board, which is the jumping-about this layout
   * exists to stop.
   */
  function scrollToStage(key: string) {
    const element = scroller.current;
    const column = columns.current[key];
    if (!element || !column) return;
    const left =
      column.getBoundingClientRect().left -
      element.getBoundingClientRect().left +
      element.scrollLeft;
    element.scrollTo({ left, behavior: "smooth" });
  }

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

  const countFor = (key: string) =>
    items.filter((card) => card.pipeline_stage === key).length;

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          <button
            className="btn-secondary px-2.5 py-1.5 text-xs"
            type="button"
            aria-label="Scroll the board left"
            disabled={atStart}
            onClick={() => scrollByColumn(-1)}
          >
            ←
          </button>
          <button
            className="btn-secondary px-2.5 py-1.5 text-xs"
            type="button"
            aria-label="Scroll the board right"
            disabled={atEnd}
            onClick={() => scrollByColumn(1)}
          >
            →
          </button>
        </div>

        {/* Jump straight to a stage. With eight or nine stages configured, the
            last few are several screens to the right of the first. */}
        <div className="flex flex-wrap gap-1">
          {stages.map((stage) => (
            <button
              key={stage.key}
              className="rounded-md border border-[var(--color-line)] bg-white px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]"
              type="button"
              onClick={() => scrollToStage(stage.key)}
            >
              {stage.label}{" "}
              <span className="text-[var(--color-muted)]">{countFor(stage.key)}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={syncEdges}
        onDragOver={(event) => {
          // Which third of the board the pointer is in, so a card held at the
          // right-hand edge pulls the far columns into view.
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientX - box.left < EDGE_ZONE_PX) setEdge(-1);
          else if (box.right - event.clientX < EDGE_ZONE_PX) setEdge(1);
          else setEdge(0);
        }}
        onDragLeave={() => setEdge(0)}
        onDrop={() => setEdge(0)}
        // min-h so a short screen falls back to the page scrolling rather than
        // squeezing the board into a letterbox.
        className="flex max-h-[calc(100vh-17rem)] min-h-96 gap-3 overflow-auto overscroll-x-contain pb-2"
      >
        {stages.map((stage) => {
          const stageCards = items.filter(
            (card) => card.pipeline_stage === stage.key,
          );

          return (
            <div
              key={stage.key}
              ref={(element) => {
                columns.current[stage.key] = element;
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(stage.key);
              }}
              onDragLeave={() => setOver((current) => (current === stage.key ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                setEdge(0);
                if (dragging) void move(dragging, stage.key);
                setDragging(null);
              }}
              className={`w-64 shrink-0 self-start rounded-lg border p-2 transition-colors ${
                over === stage.key
                  ? "border-[var(--color-brand)] bg-blue-50/40"
                  : "border-[var(--color-line)] bg-[var(--color-surface)]"
              }`}
            >
              {/* Sticks to the top of the board while the column scrolls under
                  it, so the stage a card belongs to is never off screen. The
                  background is opaque because cards pass behind it. */}
              <div
                className={`sticky top-0 z-10 -mx-2 mb-2 flex items-center justify-between px-3 py-1.5 ${
                  over === stage.key ? "bg-blue-50" : "bg-[var(--color-surface)]"
                }`}
              >
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
                    onDragEnd={() => {
                      setDragging(null);
                      setEdge(0);
                    }}
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

                    {/* Touch fallback — HTML5 drag does not fire on mobile. On
                        a desktop the arrows, the stage chips and the drag
                        auto-scroll cover reaching a far column. */}
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
