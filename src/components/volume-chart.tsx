"use client";

import { useState } from "react";

/**
 * The volume chart, rebuilt so a busy day and a quiet one actually look
 * different.
 *
 * The old version drew one thin blue bar per bucket, scaled so the tallest
 * filled the card and everything else was a short stub — 77 and 120 came out a
 * few pixels apart in a 128px box and read as identical. This one is taller,
 * puts the three numbers (sent, replies, bounces) on every bucket as coloured
 * bars, labels the sent count above each bar, and shows all three exactly on
 * hover. Nothing is scaled away to nothing: any non-zero value keeps a visible
 * minimum height.
 */

export interface VolumePoint {
  key: string;
  label: string;
  sent: number;
  replies: number;
  bounces: number;
}

const COLORS = {
  sent: "var(--color-brand)",
  replies: "var(--color-ok)",
  bounces: "var(--color-danger)",
} as const;

export function VolumeChart({
  points,
  bucketNoun,
}: {
  points: VolumePoint[];
  bucketNoun: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  // Scaled to the busiest single value across all three metrics so the bars
  // stay honest against each other. Bounces stay short because bounces should
  // be short — that is information, not a rendering bug.
  const peak = Math.max(
    1,
    ...points.map((point) => Math.max(point.sent, point.replies, point.bounces)),
  );

  // Labels above every bar get cramped past a couple of dozen columns; past
  // that the hover tooltip carries the exact numbers instead.
  const showBarLabels = points.length <= 24;
  const height = (value: number) =>
    value <= 0 ? 0 : Math.max(4, Math.round((value / peak) * 176));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs">
        <Legend color={COLORS.sent} label="Sent" />
        <Legend color={COLORS.replies} label="Replies" />
        <Legend color={COLORS.bounces} label="Bounces" />
        <span className="hint ml-auto">Peak {peak.toLocaleString()} / {bucketNoun}</span>
      </div>

      <div className="relative">
        {/* Two faint gridlines — peak and half — so a bar's height reads as a
            number, not just a shape. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-[var(--color-line)]" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--color-line)]" />

        <div className="flex h-56 items-end gap-1 overflow-x-auto pb-1">
          {points.map((point, index) => {
            const isActive = active === index;
            return (
              <div
                key={point.key}
                className="group relative flex h-full min-w-[14px] flex-1 flex-col justify-end"
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive((current) => (current === index ? null : current))}
              >
                {showBarLabels && point.sent > 0 && (
                  <span className="mb-0.5 text-center text-[10px] font-medium text-[var(--color-ink)]">
                    {point.sent}
                  </span>
                )}

                <div className="flex items-end justify-center gap-[2px]">
                  <Bar color={COLORS.sent} px={height(point.sent)} />
                  <Bar color={COLORS.replies} px={height(point.replies)} />
                  <Bar color={COLORS.bounces} px={height(point.bounces)} />
                </div>

                {isActive && (
                  <div className="absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--color-line)] bg-white px-2 py-1 text-[11px] shadow-lg">
                    <p className="font-medium">{point.label}</p>
                    <p style={{ color: COLORS.sent }}>{point.sent.toLocaleString()} sent</p>
                    <p style={{ color: COLORS.replies }}>{point.replies.toLocaleString()} replies</p>
                    <p style={{ color: COLORS.bounces }}>{point.bounces.toLocaleString()} bounces</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Bar({ color, px }: { color: string; px: number }) {
  return (
    <div
      className="w-[7px] max-w-[14px] flex-1 rounded-sm transition-opacity group-hover:opacity-90"
      style={{ height: `${px}px`, backgroundColor: color, minHeight: px > 0 ? undefined : 0 }}
    />
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-[var(--color-muted)]">{label}</span>
    </span>
  );
}
