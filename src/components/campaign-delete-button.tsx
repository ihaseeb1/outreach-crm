"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Compact delete for the campaigns list. Full rename/archive lives on the
 * campaign page; this is the one action worth reaching without opening it. */
export function CampaignDeleteButton({
  campaignId,
  name,
}: {
  campaignId: string;
  name: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!window.confirm(`Delete "${name}"? Contacts and sent mail are kept.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/campaigns?id=${encodeURIComponent(campaignId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        window.alert(payload.error ?? "Delete failed.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      window.alert("Delete failed.");
      setBusy(false);
    }
  }

  return (
    <button
      className="text-xs text-[var(--color-danger)] hover:underline disabled:opacity-50"
      type="button"
      disabled={busy}
      onClick={() => void remove()}
    >
      {busy ? "…" : "Delete"}
    </button>
  );
}
