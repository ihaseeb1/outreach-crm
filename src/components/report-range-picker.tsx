"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  REPORT_BUCKETS,
  REPORT_BUCKET_LABELS,
  REPORT_RANGE_OPTIONS,
  type ReportBucket,
  type ReportRangeKey,
} from "@/reports/ranges";

/**
 * Chooses the window the whole report covers, and how the volume chart groups
 * it.
 *
 * Both live in the URL, not in component state, so the numbers are fetched on
 * the server for whatever window is asked for — a client-side filter would mean
 * shipping a year of rows to the browser to show a week of them. It also makes
 * a particular view linkable and survives a refresh.
 *
 * The two are separate controls because they answer separate questions. Period
 * is "how far back"; grouping is "how coarse". Tying grouping to period, which
 * is what the report did before, meant a twelve-month view could only ever be
 * drawn as weeks — there was no way to ask for twelve monthly totals.
 */
export function ReportRangePicker({
  value,
  bucket,
}: {
  value: ReportRangeKey;
  bucket: ReportBucket;
}) {
  const router = useRouter();
  const [pendingRange, setPendingRange] = useState<ReportRangeKey | null>(null);
  const [pendingBucket, setPendingBucket] = useState<ReportBucket | null>(null);

  const currentRange = pendingRange ?? value;
  const currentBucket = pendingBucket ?? bucket;

  function go(next: { range?: ReportRangeKey; bucket?: ReportBucket }) {
    const params = new URLSearchParams();
    params.set("range", next.range ?? currentRange);
    params.set("bucket", next.bucket ?? currentBucket);
    router.push(`/reports?${params}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <span>Period</span>
        <select
          className="input w-auto py-1.5 text-xs"
          value={currentRange}
          onChange={(event) => {
            const next = event.target.value as ReportRangeKey;
            setPendingRange(next);
            go({ range: next });
          }}
        >
          {REPORT_RANGE_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.shortLabel}
            </option>
          ))}
        </select>
      </label>

      <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <span>Volume</span>
        <select
          className="input w-auto py-1.5 text-xs"
          value={currentBucket}
          onChange={(event) => {
            const next = event.target.value as ReportBucket;
            setPendingBucket(next);
            go({ bucket: next });
          }}
        >
          {REPORT_BUCKETS.map((option) => (
            <option key={option} value={option}>
              {REPORT_BUCKET_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
