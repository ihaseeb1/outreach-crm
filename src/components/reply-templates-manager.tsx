"use client";

import { useState } from "react";

import type { ReplyTemplate } from "@/mail/reply-templates";

/** Add, edit and remove the reply snippets that appear in the inbox reply box. */
export function ReplyTemplatesManager({
  initial,
}: {
  initial: ReplyTemplate[];
}) {
  const [templates, setTemplates] = useState<ReplyTemplate[]>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function newId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return `t_${Date.now()}_${templates.length}`;
    }
  }

  function add() {
    setTemplates((list) => [
      ...list,
      { id: newId(), name: "", body: "" },
    ]);
    setMsg(null);
  }

  function update(id: string, patch: Partial<ReplyTemplate>) {
    setTemplates((list) =>
      list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
    setMsg(null);
  }

  function remove(id: string) {
    setTemplates((list) => list.filter((t) => t.id !== id));
    setMsg(null);
  }

  async function save() {
    const cleaned = templates
      .map((t) => ({ ...t, name: t.name.trim(), body: t.body }))
      .filter((t) => t.name && t.body.trim());
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/reply-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templates: cleaned }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Save failed.");
      setTemplates(payload.templates as ReplyTemplate[]);
      setMsg("Saved.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad space-y-3">
      <h2 className="text-sm font-semibold">Reply templates</h2>
      <p className="hint">
        Saved replies you can drop into the inbox reply box with one click. Blank
        rows are dropped on save.
      </p>

      <div className="space-y-3">
        {templates.length === 0 && (
          <p className="hint">No templates yet.</p>
        )}
        {templates.map((t) => (
          <div
            key={t.id}
            className="space-y-2 rounded-md border border-[var(--color-line)] p-3"
          >
            <div className="flex items-center gap-2">
              <input
                className="input grow"
                placeholder="Template name (e.g. Send rates)"
                maxLength={80}
                value={t.name}
                onChange={(e) => update(t.id, { name: e.target.value })}
              />
              <button
                className="text-xs text-[var(--color-danger)] hover:underline"
                type="button"
                onClick={() => remove(t.id)}
              >
                Remove
              </button>
            </div>
            <textarea
              className="input min-h-24"
              placeholder="Reply text…"
              value={t.body}
              onChange={(e) => update(t.id, { body: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary" type="button" onClick={add} disabled={busy}>
          Add template
        </button>
        <button className="btn-primary" type="button" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save templates"}
        </button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </section>
  );
}
