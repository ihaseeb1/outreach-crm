"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function MailboxActions({
  id,
  email,
  isActive,
}: {
  id: string;
  email: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-2">
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

        <button
          className="btn-secondary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy !== null}
          onClick={() =>
            call(
              "toggle",
              () =>
                fetch("/api/mailboxes", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id, is_active: !isActive }),
                }),
              () => (isActive ? "Paused." : "Resumed."),
            )
          }
        >
          {isActive ? "Pause" : "Resume"}
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
