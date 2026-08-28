"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface NoteItem {
  id: string;
  body: string;
  created_at: string;
}

export interface TaskItem {
  id: string;
  title: string;
  due_date: string | null;
  done: boolean;
}

export function NotesPanel({
  contactId,
  domain,
  notes,
}: {
  contactId?: string;
  domain?: string;
  notes: NoteItem[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact_id: contactId ?? null, domain: domain ?? null, body }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      setBody("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/notes?id=${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <section className="card card-pad space-y-3">
      <h2 className="text-sm font-semibold">Notes</h2>

      <form onSubmit={add} className="space-y-2">
        <textarea
          className="input min-h-20"
          placeholder="What did they say? Anything worth remembering next time."
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={busy || !body.trim()}>
          {busy ? "Saving…" : "Add note"}
        </button>
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </form>

      {notes.length === 0 ? (
        <p className="hint">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="rounded-md border border-[var(--color-line)] p-3 text-sm"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="hint">
                  {new Date(note.created_at).toLocaleString()}
                </span>
                <button
                  className="hint text-[var(--color-danger)] hover:underline"
                  type="button"
                  onClick={() => remove(note.id)}
                >
                  Delete
                </button>
              </div>
              <pre className="whitespace-pre-wrap font-sans">{note.body}</pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The completed-tasks list, with a Clear-all and per-row delete. Split out so
 * the Tasks page can show done tasks (which its open TasksPanel filters out)
 * and still let them be cleared.
 */
export function DoneTasksList({ tasks }: { tasks: TaskItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove(id: string) {
    await fetch(`/api/tasks?id=${id}`, { method: "DELETE" });
    router.refresh();
  }

  async function clearAll() {
    setBusy(true);
    try {
      await fetch("/api/tasks?clear=done", { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (tasks.length === 0) return null;

  return (
    <section className="card card-pad">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Recently done</h2>
        <button
          type="button"
          className="hint hover:text-[var(--color-danger)] hover:underline"
          onClick={clearAll}
          disabled={busy}
        >
          {busy ? "Clearing…" : "Clear all"}
        </button>
      </div>
      <ul className="space-y-1 text-sm text-[var(--color-muted)]">
        {tasks.map((task) => (
          <li key={task.id} className="group flex items-center gap-2">
            <span className="line-through">{task.title}</span>
            <button
              type="button"
              aria-label={`Delete task: ${task.title}`}
              title="Delete task"
              className="ml-auto opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
              onClick={() => remove(task.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TasksPanel({
  contactId,
  tasks,
  title = "Tasks",
}: {
  contactId?: string;
  tasks: TaskItem[];
  title?: string;
}) {
  const router = useRouter();
  const [taskTitle, setTaskTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact_id: contactId ?? null,
          title: taskTitle,
          due_date: due || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      setTaskTitle("");
      setDue("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, done: boolean) {
    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, done }),
    });
    router.refresh();
  }

  async function remove(id: string) {
    await fetch(`/api/tasks?id=${id}`, { method: "DELETE" });
    router.refresh();
  }

  async function clearDone() {
    setBusy(true);
    try {
      await fetch("/api/tasks?clear=done", { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const doneCount = tasks.filter((task) => task.done).length;

  return (
    <section className="card card-pad space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {doneCount > 0 && (
          <button
            type="button"
            className="hint hover:text-[var(--color-danger)] hover:underline"
            onClick={clearDone}
            disabled={busy}
          >
            Clear completed ({doneCount})
          </button>
        )}
      </div>

      <form onSubmit={add} className="flex flex-wrap gap-2">
        <input
          className="input flex-1 min-w-40"
          placeholder="Follow up on the quote"
          value={taskTitle}
          onChange={(e) => setTaskTitle(e.target.value)}
        />
        <input
          className="input w-40"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={busy || !taskTitle.trim()}>
          Add
        </button>
      </form>
      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      {tasks.length === 0 ? (
        <p className="hint">Nothing outstanding.</p>
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((task) => {
            const overdue = !task.done && task.due_date && task.due_date < today;
            return (
              <li key={task.id} className="group flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={(e) => toggle(task.id, e.target.checked)}
                />
                <span className={task.done ? "text-[var(--color-muted)] line-through" : ""}>
                  {task.title}
                </span>
                {task.due_date && (
                  <span
                    className={`hint ${overdue ? "text-[var(--color-danger)]" : ""}`}
                  >
                    {overdue ? "overdue " : ""}
                    {task.due_date}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Delete task: ${task.title}`}
                  title="Delete task"
                  className="ml-auto hint opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
                  onClick={() => remove(task.id)}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
