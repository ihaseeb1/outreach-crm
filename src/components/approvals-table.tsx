"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { fmtDateTime } from "@/lib/datetime";

export interface ApprovalRow {
  id: string;
  email: string;
  full_name: string | null;
  status: "pending" | "active" | "rejected" | "banned";
  app_role: "super_admin" | "admin" | "member";
  created_at: string;
  approved_at: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-[var(--color-warn)]",
  active: "bg-green-50 text-[var(--color-ok)]",
  rejected: "bg-red-50 text-[var(--color-danger)]",
  banned: "bg-red-50 text-[var(--color-danger)]",
};

export function ApprovalsTable({
  rows,
  currentUserId,
}: {
  rows: ApprovalRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(userId: string, action: "approve" | "reject" | "ban") {
    setBusyId(userId);
    setError(null);
    try {
      const res = await fetch("/api/admin/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="card card-pad text-sm text-[var(--color-muted)]">
        No accounts yet.
      </p>
    );
  }

  return (
    <section className="card">
      {error && (
        <p className="border-b border-[var(--color-line)] px-5 py-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Role</th>
              <th>Status</th>
              <th>Signed up</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const self = row.id === currentUserId;
              const isSuper = row.app_role === "super_admin";
              const locked = self || isSuper;
              const busy = busyId === row.id;
              return (
                <tr key={row.id}>
                  <td className="font-medium">
                    {row.email}
                    {row.full_name && (
                      <span className="hint block">{row.full_name}</span>
                    )}
                  </td>
                  <td>{row.app_role}</td>
                  <td>
                    <span className={`badge ${STATUS_STYLES[row.status] ?? ""}`}>
                      {row.status}
                    </span>
                  </td>
                  <td>{fmtDateTime(row.created_at)}</td>
                  <td>
                    {locked ? (
                      <span className="hint">
                        {self ? "you" : "super admin"}
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {row.status !== "active" && (
                          <button
                            className="btn-primary px-2.5 py-1.5 text-xs"
                            disabled={busy}
                            onClick={() => act(row.id, "approve")}
                          >
                            Approve
                          </button>
                        )}
                        {row.status !== "rejected" && (
                          <button
                            className="btn-secondary px-2.5 py-1.5 text-xs"
                            disabled={busy}
                            onClick={() => act(row.id, "reject")}
                          >
                            Reject
                          </button>
                        )}
                        {row.status !== "banned" && (
                          <button
                            className="btn-secondary px-2.5 py-1.5 text-xs text-[var(--color-danger)]"
                            disabled={busy}
                            onClick={() => act(row.id, "ban")}
                          >
                            Ban
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
