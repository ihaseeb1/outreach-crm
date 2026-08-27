"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function MailboxActions({
  id,
  email,
  isActive,
  healthStatus,
  pausedReason,
}: {
  id: string;
  email: string;
  isActive: boolean;
  healthStatus?: "healthy" | "warning" | "paused";
  pausedReason?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const autoPaused = healthStatus === "paused";

  async function call(
    action: string,
    request: () => Promise<Response>,
    onOk: (payload: Record<string, unknown>) => string | null,
  ) {
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const response = await request();
      const payload = await response.json();
      if (!response.ok) throw new Error(String(payload.error ?? "Failed."));
      const text = onOk(payload);
      if (text) setMessage(text);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const post = (body: unknown, path = "/api/mailboxes/test") => () =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const patch = (body: unknown) => () =>
    fetch("/api/mailboxes", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return (
    <div className="space-y-2">
      {autoPaused && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)]">
          <p className="font-medium">Auto-paused by the health check.</p>
          {pausedReason && <p className="mt-0.5">{pausedReason}</p>}
          <p className="mt-1 text-[var(--color-muted)]">
            Outreach is stopped; warmup keeps running so the mailbox can recover.
            Resume sending once the numbers look right — no need to remove and
            re-add it.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call("verify", post({ id, mode: "verify" }), () => "Credentials OK.")
          }
        >
          {busy === "verify" ? "Checking…" : "Test connection"}
        </button>

        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call(
              "send",
              post({ id, mode: "send" }),
              () => `Test email sent to ${email}.`,
            )
          }
        >
          {busy === "send" ? "Sending…" : "Send test email"}
        </button>

        {autoPaused && (
          <button
            className="btn-primary px-2.5 py-1.5 text-xs"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              call(
                "unpause",
                patch({ id, health_status: "healthy" }),
                () => "Sending resumed — auto-pause cleared.",
              )
            }
          >
            {busy === "unpause" ? "Resuming…" : "Resume sending (clear auto-pause)"}
          </button>
        )}

        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call(
              "toggle",
              patch({ id, is_active: !isActive }),
              () => (isActive ? "Paused." : "Resumed."),
            )
          }
        >
          {isActive ? "Pause (stop everything)" : "Unpause"}
        </button>

        <button
          className="btn-danger px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy !== null}
          onClick={() => {
            if (
              !confirm(
                `Remove ${email}? Sent history is kept, but the stored credentials are deleted.`,
              )
            ) {
              return;
            }
            void call(
              "delete",
              () => fetch(`/api/mailboxes?id=${id}`, { method: "DELETE" }),
              () => null,
            );
          }}
        >
          Remove
        </button>
      </div>

      {message && <p className="text-xs text-[var(--color-ok)]">{message}</p>}
      {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
