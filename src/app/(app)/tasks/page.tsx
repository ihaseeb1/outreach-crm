import Link from "next/link";

import { TasksPanel, type TaskItem } from "@/components/notes-tasks";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

interface TaskRow extends TaskItem {
  contact_id: string | null;
  contacts: { email: string; domain: string | null } | null;
}

export default async function TasksPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from("tasks")
    .select("id, title, due_date, done, contact_id, contacts(email, domain)")
    .eq("workspace_id", session.workspace.id)
    .order("done", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(200);

  const tasks = (data ?? []) as unknown as TaskRow[];
  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);

  const today = new Date().toISOString().slice(0, 10);
  const overdue = open.filter((task) => task.due_date && task.due_date < today);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <p className="hint mt-1">
          {open.length} open
          {overdue.length > 0 && `, ${overdue.length} overdue`}.
        </p>
      </div>

      <TasksPanel tasks={open} title="Open" />

      {open.length > 0 && (
        <section className="card">
          <h2 className="border-b border-[var(--color-line)] px-5 py-3 text-sm font-semibold">
            Linked contacts
          </h2>
          <ul className="divide-y divide-[var(--color-line)]">
            {open.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span>{task.title}</span>
                {task.contact_id ? (
                  <Link
                    className="text-[var(--color-brand)] hover:underline"
                    href={`/contacts/${task.contact_id}`}
                  >
                    {task.contacts?.email ?? "contact"}
                  </Link>
                ) : (
                  <span className="hint">no contact</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section className="card card-pad">
          <h2 className="mb-2 text-sm font-semibold">Recently done</h2>
          <ul className="space-y-1 text-sm text-[var(--color-muted)]">
            {done.slice(0, 20).map((task) => (
              <li key={task.id} className="line-through">
                {task.title}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
