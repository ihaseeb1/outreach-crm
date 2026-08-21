"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CampaignStatus } from "@/types/db";

/**
 * Rename, archive and delete a campaign, on its own page. The PATCH (name,
 * status) and DELETE endpoints already existed — the campaign page just never
 * offered a way to reach them, so renaming meant editing the database by hand.
 */
export function CampaignAdmin({
  campaignId,
  name: initialName,
  status,
}: {
  campaignId: string;
  name: string;
  status: CampaignStatus;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== initialName && name.trim().length > 0;

  async function rename() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: campaignId, name: name.trim() }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Rename failed.");
      setMsg("Renamed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: CampaignStatus) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: campaignId, status: next }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Update failed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete "${initialName}"? This removes the campaign and its sequence. Contacts and their message history are kept.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/campaigns?id=${encodeURIComponent(campaignId)}`,
        { method: "DELETE" },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Delete failed.");
      router.push("/campaigns");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad space-y-3">
      <h2 className="text-sm font-semibold">Manage campaign</h2>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow">
          <label className="label" htmlFor="campaign-name">
            Name
          </label>
          <input
            id="campaign-name"
            className="input"
            value={name}
            maxLength={160}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              setMsg(null);
            }}
          />
        </div>
        <button
          className="btn-secondary"
          type="button"
          disabled={busy || !dirty}
          onClick={() => void rename()}
        >
          {busy ? "…" : "Rename"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-line)] pt-3">
        {status !== "archived" ? (
          <button
            className="btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => void setStatus("archived")}
          >
            Archive
          </button>
        ) : (
          <button
            className="btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => void setStatus("draft")}
          >
            Unarchive (to draft)
          </button>
        )}
        <button
          className="btn-secondary text-[var(--color-danger)]"
          type="button"
          disabled={busy}
          onClick={() => void remove()}
        >
          Delete campaign
        </button>
        {msg && <span className="hint text-[var(--color-ok)]">{msg}</span>}
        {error && (
          <span className="text-sm text-[var(--color-danger)]">{error}</span>
        )}
      </div>
      <p className="hint">
        Archiving hides the campaign and stops it sending without losing its
        history. Deleting removes the campaign and its sequence steps; enrolled
        contacts and their sent mail are kept.
      </p>
    </section>
  );
}
