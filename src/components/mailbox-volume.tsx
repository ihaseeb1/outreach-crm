"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import {
  VOLUME_WINDOWS,
  emptyVolume,
  perDay,
  type MailboxVolume as Volume,
  type VolumeWindow,
} from "@/mailboxes/volume";

/**
 * One window for the whole page, not one per card. Comparing mailboxes is the
 * point, and that only works if they are all reporting the same fortnight.
 */
const VolumeWindowContext = createContext<{
  days: VolumeWindow;
  setDays: (days: VolumeWindow) => void;
} | null>(null);

function useVolumeWindow() {
  const context = useContext(VolumeWindowContext);
  if (!context) {
    throw new Error("Volume components must be inside a VolumeWindowProvider.");
  }
  return context;
}

export function VolumeWindowProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<VolumeWindow>(7);
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
      {VOLUME_WINDOWS.map((window) => (
        <button
          key={window}
          type="button"
          aria-pressed={days === window}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            days === window
              ? "bg-[var(--color-brand)] text-white"
              : "text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
          }`}
          onClick={() => setDays(window)}
        >
          {window} days
        </button>
      ))}
    </div>
  );
}

export function MailboxVolume({ volume }: { volume?: Volume | null }) {
  const { days } = useVolumeWindow();
  const counts = (volume ?? emptyVolume())[days];
  const total = counts.outreach + counts.warmup;

  return (
    <div className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs text-[var(--color-muted)]">
      <div className="flex items-baseline justify-between gap-2">
        <span>Sent, last {days} days</span>
        <span className="text-[var(--color-ink)]">
          <strong>{counts.outreach}</strong> outreach
          {counts.warmup > 0 && <> · {counts.warmup} warmup</>}
        </span>
      </div>
      <p className="mt-0.5">
        {total === 0
          ? "Nothing has left this mailbox in that period."
          : `${perDay(total, days)} a day on average, warmup included.`}
      </p>
    </div>
  );
}
