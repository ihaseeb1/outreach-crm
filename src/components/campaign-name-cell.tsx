"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The campaign name in the list, renameable in place.
 *
 * Renaming already worked on the campaign's own page ("Manage campaign"), but
 * the list — where you actually look at all the names side by side and notice
 * one is wrong — only linked through to it. This puts the same rename one click
 * away from the name itself, hitting the same PATCH endpoint.
 */
export function CampaignNameCell({
  campaignId,
  name: initialName,
}: {
  campaignId: string;
  name: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) {
      setEditing(false);
      setName(initialName);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: campaignId, name: trimmed }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error ?? "Rename failed.");
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            className="input h-8 py-1 text-sm"
            value={name}
            maxLength={160}
            autoFocus
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setEditing(false);
                setName(initialName);
                setError(null);
              }
            }}
          />
          <button
            className="btn-secondary h-8 px-2 py-1 text-xs"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "…" : "Save"}
          </button>
          <button
            className="hint hover:underline"
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setName(initialName);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
        {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        className="font-medium text-[var(--color-brand)] hover:underline"
        href={`/campaigns/${campaignId}`}
      >
        {initialName}
      </Link>
      <button
        className="hint hover:underline"
        type="button"
        title="Rename this campaign"
        onClick={() => {
          setName(initialName);
          setEditing(true);
        }}
      >
        Rename
      </button>
    </div>
  );
}
