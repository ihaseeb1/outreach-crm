"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Clears a health auto-pause so outreach can resume. The health job pauses a
 * mailbox by setting `health_status = 'paused'`, which the ordinary Pause/Resume
 * (an `is_active` toggle) never touched — so before this there was no way back
 * from the UI and the mailbox had to be removed and re-added. This is the "I've
 * checked, resume it" button.
 */
export function ClearAutoPauseButton({ mailboxId }: { mailboxId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mailboxes", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: mailboxId, health_status: "healthy" }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not resume.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        className="btn-primary px-2.5 py-1.5 text-xs"
        type="button"
        disabled={busy}
        onClick={() => void resume()}
      >
        {busy ? "Resuming…" : "Resume sending (clear auto-pause)"}
      </button>
      {error && <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
