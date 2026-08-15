"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Runs one batch of a background job for the current workspace. The same
 * batches run automatically on the cron tick; this is for impatience and testing.
 */
export function RunJobButton({
  job,
  label,
  limit,
}: {
  job: "scrape" | "validate";
  label: string;
  limit?: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job, limit }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Job failed.");
      setMessage(
        job === "scrape"
          ? `Scraped ${payload.processed}, found ${payload.contactsCreated} new contacts.`
          : `Validated ${payload.processed} (${payload.valid} sendable).`,
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button className="btn-secondary" onClick={run} disabled={busy} type="button">
        {busy ? "Running…" : label}
      </button>
      {message && <span className="hint">{message}</span>}
    </div>
  );
}
