import { NextResponse } from "next/server";
import { z } from "zod";

import { normalizeEmail } from "@/lib/email";
import { getSession } from "@/lib/workspace";
import { verifyMany } from "@/validation/verify-engine";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  text: z.string().min(1).max(500_000),
});

// Quick-mode bulk is fast, but MX lookups are still network calls; cap so the
// request returns inside the function limit. Larger lists belong on the Contacts
// screen, which validates in the background across many cron ticks.
const MAX_EMAILS = 300;

const EMAIL_RE = /[^\s,;<>()[\]"']+@[^\s,;<>()[\]"']+\.[a-z]{2,}/gi;

function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_RE) ?? [];
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of found) {
    const email = normalizeEmail(raw);
    if (email && !seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }
  return emails;
}

/**
 * Bulk verifier — paste any list of addresses, get a Reoon-style breakdown back.
 *
 * Quick mode only (it runs on the deployed app), so it confirms syntax, domain,
 * MX, disposable, role and traps but not individual-mailbox existence. For the
 * deep mailbox check, import the list into Contacts and let the power worker run.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body." },
      { status: 400 },
    );
  }

  const all = extractEmails(parsed.data.text);
  if (all.length === 0) {
    return NextResponse.json({ error: "No email addresses found in that text." }, { status: 400 });
  }

  const emails = all.slice(0, MAX_EMAILS);
  const results = await verifyMany(emails, { mode: "quick" });

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    submitted: all.length,
    verified: results.length,
    truncated: Math.max(0, all.length - emails.length),
    summary,
    results,
  });
}
