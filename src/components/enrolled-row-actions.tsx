"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-contact controls on the campaign's enrolled table (spec §4.2). "Send now"
 * pushes this contact's current step out immediately; "Remove" takes it out of
 * the campaign. Terminal contacts (replied/bounced/opted out/completed) get no
 * Send now — there is nothing left to send.
 */
export function EnrolledRowActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "send_now" | "remove">(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const terminal = ["replied", "bounced", "unsubscribed", "completed"].includes(
    status,
  );

  async function run(action: "send_now" | "remove") {
    if (action === "remove" && !confirm("Remove this contact from the campaign?")) {
      return;
    }
    setBusy(action);
    setNote(null);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/contacts/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        return;
      }
      setNote(json.message ?? "Done.");
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {!terminal && (
          <button
            className="btn-primary px-2 py-1 text-xs"
            disabled={busy !== null}
            onClick={() => run("send_now")}
          >
            {busy === "send_now" ? "Sending…" : "Send now"}
          </button>
        )}
        <button
          className="btn-secondary px-2 py-1 text-xs"
          disabled={busy !== null}
          onClick={() => run("remove")}
        >
          {busy === "remove" ? "Removing…" : "Remove"}
        </button>
      </div>
      {note && <span className="hint text-[var(--color-ok)]">{note}</span>}
      {error && <span className="hint text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}
