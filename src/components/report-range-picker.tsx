"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  REPORT_RANGE_OPTIONS,
  type ReportRangeKey,
} from "@/reports/ranges";

/**
 * Chooses the window the whole report covers.
 *
 * The range lives in the URL, not in component state, so the numbers are fetched
 * on the server for whatever window is asked for — a client-side filter would
 * mean shipping a year of rows to the browser to show a week of them. It also
 * makes a particular view linkable and survives a refresh.
 */
export function ReportRangePicker({ value }: { value: ReportRangeKey }) {
  const router = useRouter();
  const [pending, setPending] = useState<ReportRangeKey | null>(null);

  return (
    <label className="inline-flex items-center gap-2 text-xs text-[var(--color-muted)]">
      <span>Period</span>
      <select
        className="input w-auto py-1.5 text-xs"
        value={pending ?? value}
        onChange={(event) => {
          const next = event.target.value as ReportRangeKey;
          setPending(next);
          router.push(`/reports?range=${next}`);
        }}
      >
        {REPORT_RANGE_OPTIONS.map((option) => (
          <option key={option.key} value={option.key}>
            {option.shortLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
