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

/** One coloured metric drawn as a bar in each bucket. */
export interface ChartMetric {
  key: string;
  label: string;
  color: string;
}

export interface TrendPoint {
  key: string;
  label: string;
  values: Record<string, number>;
}

/** Volume chart: sent / replies / bounces per bucket. Thin wrapper over the
 *  generic BarTrendChart so both charts on Reports look and behave the same. */
export function VolumeChart({
  points,
  bucketNoun,
}: {
  points: VolumePoint[];
  bucketNoun: string;
}) {
  return (
    <BarTrendChart
      bucketNoun={bucketNoun}
      metrics={[
        { key: "sent", label: "Sent", color: COLORS.sent },
        { key: "replies", label: "Replies", color: COLORS.replies },
        { key: "bounces", label: "Bounces", color: COLORS.bounces },
      ]}
      labelMetric="sent"
      points={points.map((point) => ({
        key: point.key,
        label: point.label,
        values: { sent: point.sent, replies: point.replies, bounces: point.bounces },
      }))}
    />
  );
}

/**
 * A grouped bar chart for any set of per-bucket metrics: sent/replies/bounces,
 * or opens/clicks. Every bucket shows one coloured bar per metric, the numbers
 * are printed above the bars on short ranges, and a readout line above the
 * chart (plus a native tooltip on each bar) carries the exact numbers on hover
 * — the readout is above the scroll area so it is never clipped.
 */
export function BarTrendChart({
  points,
  metrics,
  bucketNoun,
  labelMetric,
}: {
  points: TrendPoint[];
  metrics: ChartMetric[];
  bucketNoun: string;
  /** Which metric's number to print above each bar; defaults to the first. */
  labelMetric?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const labelKey = labelMetric ?? metrics[0]?.key ?? "";

  // Scaled to the busiest single value across every metric so the bars stay
  // honest against each other.
  const peak = Math.max(
    1,
    ...points.map((point) =>
      Math.max(...metrics.map((metric) => point.values[metric.key] ?? 0)),
    ),
  );

  // Labels above every bar get cramped past a couple of dozen columns; past
  // that the readout line and the native tooltip carry the exact numbers.
  const showBarLabels = points.length <= 24;
  const height = (value: number) =>
    value <= 0 ? 0 : Math.max(4, Math.round((value / peak) * 176));

  // The bucket to read out above the chart: whichever is hovered, otherwise the
  // most recent one, so a number is always on screen without hovering.
  const shown = active !== null ? points[active] : points[points.length - 1];
  const titleFor = (point: TrendPoint) =>
    `${point.label}: ${metrics
      .map((metric) => `${point.values[metric.key] ?? 0} ${metric.label.toLowerCase()}`)
      .join(", ")}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {metrics.map((metric) => (
          <Legend key={metric.key} color={metric.color} label={metric.label} />
        ))}
        <span className="hint ml-auto">Peak {peak.toLocaleString()} / {bucketNoun}</span>
      </div>

      {/* Live readout — rendered ABOVE the scrolling bars so it is never clipped,
          which is what hid the hover numbers before. Updates as you move across
          the bars; shows the latest bucket when nothing is hovered. */}
      {shown && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-[var(--color-canvas)] px-3 py-2 text-sm">
          <span className="font-medium">{shown.label}</span>
          {metrics.map((metric) => (
            <span key={metric.key} style={{ color: metric.color }}>
              {(shown.values[metric.key] ?? 0).toLocaleString()} {metric.label.toLowerCase()}
            </span>
          ))}
          {active === null && <span className="hint">— hover a bar for any {bucketNoun}</span>}
        </div>
      )}

      <div className="relative">
        {/* Two faint gridlines — peak and half — so a bar's height reads as a
            number, not just a shape. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-[var(--color-line)]" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-[var(--color-line)]" />

        <div className="flex h-56 items-end gap-1 overflow-x-auto pb-1">
          {points.map((point, index) => (
            <div
              key={point.key}
              // Native tooltip too, so the numbers show on hover even where the
              // scroll area would clip a custom popover.
              title={titleFor(point)}
              className={`group flex h-full min-w-[14px] flex-1 flex-col justify-end rounded-sm ${
                active === index ? "bg-[var(--color-canvas)]" : ""
              }`}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive((current) => (current === index ? null : current))}
            >
              {showBarLabels && (point.values[labelKey] ?? 0) > 0 && (
                <span className="mb-0.5 text-center text-[10px] font-medium text-[var(--color-ink)]">
                  {point.values[labelKey]}
                </span>
              )}

              <div className="flex items-end justify-center gap-[2px]">
                {metrics.map((metric) => (
                  <Bar key={metric.key} color={metric.color} px={height(point.values[metric.key] ?? 0)} />
                ))}
              </div>
            </div>
          ))}
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
