import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { isRoleAccount } from "@/lib/email";
import { resolveRespectRobots } from "@/scraper/safety";
import { verifyEmail } from "@/validation/verify-engine";
import type { ValidationStatus } from "@/types/db";
import { scrapeContacts } from "@/discovery/enrich/contactScrape";
import { pickBestEmail } from "@/discovery/enrich/pickEmail";
import { normalizePhone } from "@/discovery/enrich/phone";
import type { ActiveAuthor, AuthorEmailStatus } from "@/types/db";

/**
 * Cron/worker batch for Phase 4. Claims active authors that haven't been
 * enriched, self-scrapes their destination site for a contact email + phone,
 * verifies the email with the free in-house engine (syntax + MX + disposable +
 * role, no paid API), and normalizes the phone to E.164. Reuses the existing
 * scraper and verifier. Idempotent: a row is claimed with enriched_at.
 */

export interface EnrichBatchResult {
  processed: number;
  withEmail: number;
  verified: number;
}

/** Map the verifier's rich verdict onto the author email status. */
function toAuthorEmailStatus(status: ValidationStatus): AuthorEmailStatus {
  switch (status) {
    case "invalid_syntax":
      return "invalid_syntax";
    case "no_mx":
      return "no_mx";
    case "disposable":
      return "disposable";
    case "role_account":
      return "role_account";
    case "valid":
    case "safe":
      return "verified";
    default:
      // unknown, catch_all, spamtrap, invalid, disabled, inbox_full, …
      return "unverified";
  }
}

function confidenceFor(onDomain: boolean, email: string, verified: boolean): number {
  let base = onDomain ? (isRoleAccount(email) ? 0.6 : 0.85) : 0.35;
  if (verified) base = Math.min(1, base + 0.1);
  return Math.round(base * 100) / 100;
}

export async function runEnrichBatch(
  supabase: SupabaseClient,
  options: { limit?: number; workspaceId?: string } = {},
): Promise<EnrichBatchResult> {
  const limit = options.limit ?? 5;
  const result: EnrichBatchResult = { processed: 0, withEmail: 0, verified: 0 };

  let query = supabase
    .from("active_authors")
    .select("*")
    .is("enriched_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);

  const { data, error } = await query;
  if (error) return result; // pre-0018 or transient.

  const respectByWorkspace = new Map<string, boolean>();
  const respectFor = async (workspaceId: string): Promise<boolean> => {
    const cached = respectByWorkspace.get(workspaceId);
    if (cached !== undefined) return cached;
    const { data: ws } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle();
    const respect = resolveRespectRobots((ws as { settings?: Record<string, unknown> } | null)?.settings);
    respectByWorkspace.set(workspaceId, respect);
    return respect;
  };

  for (const author of (data ?? []) as ActiveAuthor[]) {
    // Claim: only the caller that stamps enriched_at proceeds.
    const { data: claimed } = await supabase
      .from("active_authors")
      .update({ enriched_at: new Date().toISOString() })
      .eq("id", author.id)
      .is("enriched_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      const respectRobots = await respectFor(author.workspace_id);
      const scraped = await scrapeContacts(supabase, author.destination_domain, { respectRobots });

      const update: Record<string, unknown> = {};

      const pick = pickBestEmail(scraped.emails, author.destination_domain);
      if (pick) {
        const verdict = await verifyEmail(pick.email, { mode: "quick" });
        const emailStatus = toAuthorEmailStatus(verdict.status);
        update.email = pick.email;
        update.email_status = emailStatus;
        update.contact_confidence = confidenceFor(pick.onDomain, pick.email, emailStatus === "verified");
        result.withEmail += 1;
        if (emailStatus === "verified") result.verified += 1;
      }

      const phoneRaw = scraped.phones[0];
      if (phoneRaw) {
        const normalized = normalizePhone(phoneRaw);
        if (normalized) {
          update.phone = normalized.e164;
          update.phone_region = normalized.region;
        }
      }

      if (Object.keys(update).length > 0) {
        await supabase.from("active_authors").update(update).eq("id", author.id);
      }
      result.processed += 1;
    } catch {
      // enriched_at is already set, so a failed row simply won't retry.
      result.processed += 1;
    }
  }

  if (result.withEmail > 0 && data && data.length > 0) {
    await logActivity(supabase, {
      workspaceId: (data[0] as ActiveAuthor).workspace_id,
      action: "discovery.authors_enriched",
      meta: { processed: result.processed, withEmail: result.withEmail, verified: result.verified },
    });
  }

  return result;
}
