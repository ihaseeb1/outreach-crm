"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import {
  TODAY,
  VOLUME_VIEWS,
  countsFor,
  perDay,
  type MailboxVolume as Volume,
  type VolumeKey,
} from "@/mailboxes/volume";

/**
 * One window for the whole page, not one per card. Comparing mailboxes is the
 * point, and that only works if they are all reporting the same fortnight.
 */
const VolumeWindowContext = createContext<{
  days: VolumeKey;
  setDays: (days: VolumeKey) => void;
} | null>(null);

function useVolumeWindow() {
  const context = useContext(VolumeWindowContext);
  if (!context) {
    throw new Error("Volume components must be inside a VolumeWindowProvider.");
  }
  return context;
}

export function VolumeWindowProvider({ children }: { children: ReactNode }) {
  // Opens on today. What was sent in the last few hours is the question being
  // asked when this page is loaded — whether a mailbox is working right now,
  // and how much of today's allowance went on warmup.
  const [days, setDays] = useState<VolumeKey>(TODAY);
  return (
    <VolumeWindowContext.Provider value={{ days, setDays }}>
      {children}
    </VolumeWindowContext.Provider>
  );
}

export function VolumeWindowToggle() {
  const { days, setDays } = useVolumeWindow();

  return (
    <div
      className="inline-flex rounded-md border border-[var(--color-line)] bg-white p-0.5"
      role="group"
      aria-label="Sent volume window"
    >
      {VOLUME_VIEWS.map((view) => (
        <button
          key={String(view.key)}
          type="button"
          aria-pressed={days === view.key}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            days === view.key
              ? "bg-[var(--color-brand)] text-white"
              : "text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
          }`}
          onClick={() => setDays(view.key)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}

export function MailboxVolume({ volume }: { volume?: Volume | null }) {
  const { days } = useVolumeWindow();
  const counts = countsFor(volume ?? undefined, days);
  const total = counts.outreach + counts.warmup;
  const isToday = days === TODAY;

  return (
    <div className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
      <div className="flex items-baseline justify-between gap-2">
        <span>{isToday ? "Sent today" : `Sent, last ${days} days`}</span>
        <span className="text-[var(--color-ink)]">
          <strong>{total}</strong>
        </span>
      </div>
      {/* Today gets the split and no average: "0.0 a day" for a day that is
          still happening says nothing, and the split — how much of today's
          allowance went on warmup rather than on real prospects — is the whole
          reason to look at a single day. */}
      <p className="mt-0.5">
        {total === 0 ? (
          isToday
            ? "Nothing has left this mailbox today."
            : "Nothing has left this mailbox in that period."
        ) : (
          <>
            {!isToday && `${perDay(total, days as number)} a day on average. `}
            {/* A share of the total, not an addition to it — warmup spends the
                same daily limit as real outreach. */}
            {counts.warmup > 0
              ? `${counts.warmup} warmup, ${counts.outreach} real outreach.`
              : `All ${total === 1 ? "of it" : "of them"} real outreach, no warmup.`}
          </>
        )}
      </p>
    </div>
  );
}
