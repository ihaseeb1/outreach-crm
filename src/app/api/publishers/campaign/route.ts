import { NextResponse } from "next/server";
import { z } from "zod";

import { logActivity } from "@/lib/activity";
import { splitName } from "@/lib/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { suppressedSubset } from "@/mail/suppressions";
import { authorEligibility, phoneComplianceFlags } from "@/discovery/compliance";
import { loadSuppressionSets, isEmailSuppressed } from "@/discovery/suppression";
import type { ActiveAuthor } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
});

/**
 * Promotes selected active authors into the workspace contact list (the pool
 * campaigns enroll from), with personalization tokens pre-filled.
 *
 * Compliance gate: only verified, non-suppressed, non-role (unless the
 * workspace opts in) authors are added; the rest are skipped with a reason.
 * Duplicates are blocked by the contacts unique(workspace_id, email). Phone
 * region flags are attached advisory-only.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const workspaceId = session.workspace.id;
  const supabase = await createSupabaseServerClient();

  const { data: authorRows, error } = await supabase
    .from("active_authors")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("id", parsed.data.ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const authors = (authorRows ?? []) as ActiveAuthor[];
  if (authors.length === 0) {
    return NextResponse.json({ ok: true, added: 0, skipped: 0 });
  }

  const allowRole =
    ((session.workspace.settings as { discovery?: { allow_role_emails?: boolean } } | null)
      ?.discovery?.allow_role_emails) === true;

  // Suppression: the discovery blacklist + the outbound suppression list.
  const discoverySets = await loadSuppressionSets(supabase, workspaceId);
  const emails = authors.map((a) => a.email ?? "").filter(Boolean);
  const outboundSuppressed = await suppressedSubset(supabase, workspaceId, emails);

  const eligible: ActiveAuthor[] = [];
  const skips: { author: string; reason: string }[] = [];

  for (const author of authors) {
    const email = author.email ?? null;
    const suppressed = Boolean(
      email && (outboundSuppressed.has(email.toLowerCase()) || isEmailSuppressed(email, discoverySets)),
    );
    const decision = authorEligibility(
      { email, emailStatus: author.email_status, suppressed },
      { allowRole },
    );
    if (decision.eligible) eligible.push(author);
    else skips.push({ author: author.destination_domain, reason: decision.reason ?? "ineligible" });
  }

  if (eligible.length === 0) {
    return NextResponse.json({ ok: true, added: 0, skipped: skips.length, skips: skips.slice(0, 20) });
  }

  const now = new Date().toISOString();
  const rows = eligible.map((a) => {
    const { first, last } = splitName(a.author_name);
    return {
      workspace_id: workspaceId,
      email: a.email,
      first_name: first,
      last_name: last,
      phone: a.phone,
      website: `https://${a.destination_domain}`,
      domain: a.destination_domain,
      source_url: a.source_post_url,
      scraped_at: now,
      validation_status: "valid",
      pipeline_stage: "new",
      tags: ["guest-author"],
      meta: {
        // Personalization tokens for the first line of outreach.
        personalization: {
          author_name: a.author_name,
          latest_post_title: a.latest_post_title,
          source_post_url: a.source_post_url,
          destination_domain: a.destination_domain,
        },
        compliance: { phone_flags: phoneComplianceFlags(a.phone_region) },
        active_author_id: a.id,
      },
    };
  });

  const { data: upserted, error: upsertError } = await supabase
    .from("contacts")
    .upsert(rows, { onConflict: "workspace_id,email", ignoreDuplicates: true })
    .select("id, email");
  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  const added = (upserted ?? []).length;

  // Mark the promoted authors as contacted.
  await supabase
    .from("active_authors")
    .update({ status: "contacted" })
    .eq("workspace_id", workspaceId)
    .in("id", eligible.map((a) => a.id));

  await logActivity(supabase, {
    workspaceId,
    actorId: session.userId,
    action: "discovery.authors_to_contacts",
    meta: { added, skipped: skips.length, eligible: eligible.length },
  });

  return NextResponse.json({
    ok: true,
    added,
    skipped: skips.length,
    skips: skips.slice(0, 20),
  });
}
