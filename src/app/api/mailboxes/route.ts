import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { encryptJson } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/email";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
// PATCH and DELETE keep the request-scoped client: neither reads the row back,
// so the revoked-column problem does not apply, and they keep RLS as a second
// line of defence behind the explicit workspace filter.
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { providerForMailbox } from "@/mail/providers";
import { presetFor } from "@/mail/providers/presets";
import type { MailboxCredentials } from "@/mail/providers/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const connectSchema = z.object({
  provider: z.enum(["gmail", "outlook", "smtp"]),
  email: z.string().email(),
  password: z.string().min(1),
  from_name: z.string().max(120).optional(),
  signature: z.string().max(2000).optional(),
  daily_limit: z.number().int().min(1).max(2000).optional(),
  // Up to 24h either side: a slow-drip mailbox sending twice a day is a
  // legitimate warmup posture, and the old 1h ceiling made it unexpressible.
  min_gap_seconds: z.number().int().min(10).max(86_400).optional(),
  max_gap_seconds: z.number().int().min(10).max(86_400).optional(),
  // Only needed for the "other" provider.
  smtp_host: z.string().optional(),
  smtp_port: z.number().int().optional(),
  smtp_secure: z.boolean().optional(),
  imap_host: z.string().optional(),
  imap_port: z.number().int().optional(),
  imap_secure: z.boolean().optional(),
});

/**
 * Connects a mailbox. Credentials are verified against the real servers before
 * anything is stored, then encrypted at rest — they are never returned to the
 * browser and never logged.
 *
 * Any number of mailboxes can be connected; campaigns rotate across all active
 * ones and warmup pairs them up.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = connectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const email = normalizeEmail(input.email);
  const preset = presetFor(input.provider);

  const credentials: MailboxCredentials = {
    smtp: {
      host: input.smtp_host || preset.smtp.host,
      port: input.smtp_port ?? preset.smtp.port,
      secure: input.smtp_secure ?? preset.smtp.secure,
      user: email,
      pass: input.password,
    },
    imap: {
      host: input.imap_host || preset.imap.host,
      port: input.imap_port ?? preset.imap.port,
      secure: input.imap_secure ?? preset.imap.secure,
      user: email,
      pass: input.password,
    },
  };

  if (!credentials.smtp.host || !credentials.imap.host) {
    return NextResponse.json(
      { error: "SMTP and IMAP hosts are required for a custom provider." },
      { status: 400 },
    );
  }

  const provider = providerForMailbox(
    { email, from_name: input.from_name ?? null, auth_type: "app_password" },
    credentials,
  );

  const verification = await provider.verify().finally(() => provider.close());
  if (!verification.ok) {
    return NextResponse.json(
      {
        error: verification.error ?? "Could not verify the mailbox.",
        smtp: verification.smtp ?? false,
        imap: verification.imap ?? false,
      },
      { status: 400 },
    );
  }

  // Must be the admin client, not the request-scoped one.
  //
  // Migration 0002 revokes table-level SELECT on mailboxes from `authenticated`
  // and re-grants it column by column, deliberately leaving out
  // encrypted_credentials so credentials can never reach the browser. PostgREST
  // reads the row back after an insert-with-representation, that read touches
  // the revoked column, and the whole statement dies with
  // "permission denied for table mailboxes" — the write itself was fine.
  //
  // Every query below is scoped by session.workspace.id by hand, because the
  // service role bypasses RLS and nothing else would confine it.
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("mailboxes")
    .upsert(
      {
        workspace_id: session.workspace.id,
        provider: input.provider,
        auth_type: "app_password",
        email,
        from_name: input.from_name ?? null,
        signature: input.signature ?? null,
        encrypted_credentials: encryptJson(credentials),
        daily_limit: input.daily_limit ?? 50,
        min_gap_seconds: input.min_gap_seconds ?? 90,
        max_gap_seconds: input.max_gap_seconds ?? 300,
        is_active: true,
        health_status: "healthy",
        last_error: null,
      },
      { onConflict: "workspace_id,email" },
    )
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const mailboxId = (data as { id: string }).id;

  // Warmup starts on its own. It used to require finding the toggle and
  // switching it on per mailbox, which meant the common case — connect a
  // mailbox, start sending — ran a completely cold inbox at full volume.
  //
  // ignoreDuplicates so reconnecting a mailbox cannot reset a ramp that is
  // already partway up; the schema defaults (5/day climbing by 2 toward 40)
  // only apply to a genuinely new row. The engine skips any workspace with
  // fewer than two enabled mailboxes, so enabling the first one is harmless
  // and it simply begins when the second arrives.
  await supabase.from("warmup_settings").upsert(
    {
      mailbox_id: mailboxId,
      workspace_id: session.workspace.id,
      enabled: true,
      started_at: new Date().toISOString(),
    },
    { onConflict: "mailbox_id", ignoreDuplicates: true },
  );

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "mailbox.connected",
    entityType: "mailbox",
    entityId: mailboxId,
    meta: { email, provider: input.provider, warmup: "auto-enabled" },
  });

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}

const patchSchema = z.object({
  id: z.string().uuid(),
  is_active: z.boolean().optional(),
  daily_limit: z.number().int().min(1).max(2000).optional(),
  from_name: z.string().max(120).nullable().optional(),
  signature: z.string().max(2000).nullable().optional(),
  // Up to 24h either side: a slow-drip mailbox sending twice a day is a
  // legitimate warmup posture, and the old 1h ceiling made it unexpressible.
  min_gap_seconds: z.number().int().min(10).max(86_400).optional(),
  max_gap_seconds: z.number().int().min(10).max(86_400).optional(),
});

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { id, ...patch } = parsed.data;

  // A max below the min would make randomGapMs collapse to the min silently.
  // Rejecting is better than quietly ignoring half of what was asked for.
  if (
    patch.min_gap_seconds !== undefined &&
    patch.max_gap_seconds !== undefined &&
    patch.max_gap_seconds < patch.min_gap_seconds
  ) {
    return NextResponse.json(
      { error: "The maximum gap must be at least the minimum gap." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from("mailboxes")
    .update(patch)
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("mailboxes")
    .delete()
    .eq("id", id)
    .eq("workspace_id", session.workspace.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logActivity(supabase, {
    workspaceId: session.workspace.id,
    actorId: session.userId,
    action: "mailbox.removed",
    entityType: "mailbox",
    entityId: id,
  });

  return NextResponse.json({ ok: true });
}
