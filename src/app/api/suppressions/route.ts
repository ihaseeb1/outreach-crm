import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { normalizeEmail } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { suppressEmail } from "@/mail/suppressions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addSchema = z.object({
  emails: z.string().min(1).max(200_000),
  reason: z
    .enum(["unsubscribed", "hard_bounce", "complaint", "manual", "opted_out"])
    .default("manual"),
});

/** Manually add addresses to the suppression list. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const emails = [
    ...new Set(
      parsed.data.emails
        .split(/[\s,;]+/)
        .map(normalizeEmail)
        .filter((value) => value.includes("@")),
    ),
  ].slice(0, 5000);

  if (emails.length === 0) {
    return NextResponse.json({ error: "No valid addresses." }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  for (const email of emails) {
    await suppressEmail(supabase, {
      workspaceId: session.workspace.id,
      email,
      reason: parsed.data.reason,
      source: "manual_ui",
      actorId: session.userId,
    });
  }

  return NextResponse.json({ ok: true, added: emails.length });
}

/**
 * Reasons that need `confirm` before they will come off the list. Not exported:
 * a route module may only export handlers and route config.
 */
const PROTECTED_REASONS = new Set(["hard_bounce", "complaint"]);

/**
 * Removing suppressions, one or many.
 *
 * A hard bounce or a complaint used to be undeletable full stop, and the row
 * simply read "locked" with no way past it. That is one guard too many: a
 * bounce classified from wording rather than an SMTP code can be wrong, and an
 * address wrongly written off had no route back into the workspace at all.
 *
 * So they are deletable, but never by accident — the caller has to pass
 * `confirm=1`, and the screen makes the reader type nothing less than a
 * separate confirmation first. Every removal is logged with its reason, because
 * "why is this address being emailed again" is a question that gets asked
 * months later.
 */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;

  // Clearing the whole list is its own path, not a very long list of ids. The
  // page only holds the newest 1,000 rows, so deleting "everything on screen"
  // would quietly leave the rest behind — and the point of clearing is to stop
  // paying for storage on entries that are no longer worth keeping.
  if (params.get("all") === "1") {
    return clearAll(request, session);
  }

  const ids = [
    ...new Set(
      [...(params.get("id") ? [params.get("id")!] : []), ...(params.getAll("ids"))]
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, 1000);

  if (ids.length === 0) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }

  const confirmed = params.get("confirm") === "1";

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("suppressions")
    .select("id, email, reason")
    .eq("workspace_id", session.workspace.id)
    .in("id", ids);

  const rows = (data ?? []) as { id: string; email: string; reason: string }[];
  if (rows.length === 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const protectedRows = rows.filter((row) => PROTECTED_REASONS.has(row.reason));
  if (protectedRows.length > 0 && !confirmed) {
    return NextResponse.json(
      {
        error: `${protectedRows.length} of these bounced or complained. Removing them risks your sending reputation — confirm to remove anyway.`,
        needsConfirmation: protectedRows.map((row) => row.email),
      },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("suppressions")
    .delete()
    .eq("workspace_id", session.workspace.id)
    .in(
      "id",
      rows.map((row) => row.id),
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    action: "suppression.removed",
    actorId: session.userId,
    meta: {
      count: rows.length,
      emails: rows.slice(0, 25).map((row) => row.email),
      reasons: [...new Set(rows.map((row) => row.reason))],
      forced: protectedRows.length > 0,
    },
  });

  return NextResponse.json({ ok: true, removed: rows.length });
}

/**
 * Empties the list — everything, or everything matching the filter the reader
 * can see on screen.
 *
 * Scoped by the same reason filter and the same search box as the table, so
 * "Clear the list" always means what the screen is showing rather than
 * something wider. Counted before it is deleted, because a delete cannot report
 * how many rows it removed once they are gone, and "cleared 0" would be
 * indistinguishable from a failure.
 */
async function clearAll(
  request: Request,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
) {
  const params = new URL(request.url).searchParams;
  const reason = params.get("reason");
  const search = (params.get("q") ?? "").trim();
  const confirmed = params.get("confirm") === "1";

  const supabase = await createSupabaseServerClient();

  const scoped = () => {
    let query = supabase
      .from("suppressions")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", session.workspace.id);
    if (reason) query = query.eq("reason", reason);
    if (search) {
      query = query.or(`email.ilike.%${search}%,source.ilike.%${search}%`);
    }
    return query;
  };

  const { count: total, error: countError } = await scoped();
  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }
  if (!total) {
    return NextResponse.json({ error: "Nothing to clear." }, { status: 400 });
  }

  const { count: risky } = await scoped().in("reason", [...PROTECTED_REASONS]);

  if ((risky ?? 0) > 0 && !confirmed) {
    return NextResponse.json(
      {
        error: `${risky} of these ${
          risky === 1 ? "address" : "addresses"
        } bounced or complained. Clearing them means they can be emailed again — confirm to clear anyway.`,
        needsConfirmation: [],
        protectedCount: risky,
        total,
      },
      { status: 409 },
    );
  }

  let deletion = supabase
    .from("suppressions")
    .delete()
    .eq("workspace_id", session.workspace.id);
  if (reason) deletion = deletion.eq("reason", reason);
  if (search) {
    deletion = deletion.or(`email.ilike.%${search}%,source.ilike.%${search}%`);
  }

  const { error } = await deletion;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    action: "suppression.cleared",
    actorId: session.userId,
    meta: {
      count: total,
      scope: reason || search ? { reason: reason ?? null, search: search || null } : "everything",
      protected: risky ?? 0,
    },
  });

  return NextResponse.json({ ok: true, removed: total, cleared: true });
}
