import type { SupabaseClient } from "@supabase/supabase-js";

import { logActivity } from "@/lib/activity";
import { parseBacklink, type LinkStatus } from "@/deals/backlink";
import { crawlableUrl } from "@/scraper/safety";
import { defaultScraper } from "@/scraper/static-scraper";
import type { Scraper } from "@/scraper/types";

/**
 * Live backlink verifier (spec §9), orchestration.
 *
 * Fetches a deal's `placed_url` (through the hardened scraper, so the SSRF guard
 * and retries apply) and checks the link to `target_url` is really live, then
 * writes the verdict back onto the deal. Used by the "Verify now" button and the
 * backlinks cron.
 */

export interface VerifiableDeal {
  id: string;
  placed_url: string | null;
  target_url: string | null;
  anchor_text: string | null;
}

export interface VerifyResult {
  status: LinkStatus | "skipped";
  detail: string;
  isDofollow: boolean | null;
}

let placementColumnsPresent = false;

/**
 * Whether migration 0012 is applied. Cached true forever once seen; a false is
 * re-probed so an instance that started before the migration picks it up.
 */
export async function dealPlacementReady(supabase: SupabaseClient): Promise<boolean> {
  if (placementColumnsPresent) return true;
  const { error } = await supabase.from("deals").select("link_status").limit(1);
  placementColumnsPresent = !error;
  return placementColumnsPresent;
}

export async function verifyDealBacklink(
  supabase: SupabaseClient,
  deal: VerifiableDeal,
  opts: { scraper?: Scraper; workspaceId: string; actorId?: string | null } = {
    workspaceId: "",
  },
): Promise<VerifyResult> {
  const scraper = opts.scraper ?? defaultScraper;

  if (!deal.placed_url || !deal.target_url) {
    return {
      status: "skipped",
      detail: "Set both the placed URL and the target URL to verify.",
      isDofollow: null,
    };
  }

  const guard = crawlableUrl(deal.placed_url);
  let status: LinkStatus;
  let detail: string;
  let isDofollow: boolean | null = null;

  if (!guard.ok) {
    status = "error";
    detail = `Placed URL rejected: ${guard.reason}.`;
  } else {
    const outcome = await scraper.fetchPage(deal.placed_url);
    if (!outcome.ok) {
      status = "error";
      detail = `Could not fetch the page: ${outcome.failure.error}.`;
    } else {
      const verdict = parseBacklink(outcome.page.html, {
        targetUrl: deal.target_url,
        anchorText: deal.anchor_text,
        pageUrl: outcome.page.finalUrl,
      });
      status = verdict.status;
      detail = verdict.detail;
      isDofollow = verdict.isDofollow;
    }
  }

  await supabase
    .from("deals")
    .update({
      link_status: status,
      link_is_dofollow: isDofollow,
      link_checked_at: new Date().toISOString(),
      link_detail: detail,
    })
    .eq("id", deal.id)
    .eq("workspace_id", opts.workspaceId);

  await logActivity(supabase, {
    workspaceId: opts.workspaceId,
    actorId: opts.actorId ?? null,
    action: "deal.backlink_checked",
    entityType: "deal",
    entityId: deal.id,
    meta: { status, dofollow: isDofollow, placed_url: deal.placed_url },
  });

  return { status, detail, isDofollow };
}

/**
 * Verifies a batch of placements that have a URL, least-recently checked first.
 * Best-effort and self-limiting so a cron tick stays inside its budget.
 */
export async function verifyDueBacklinks(
  supabase: SupabaseClient,
  opts: { limit?: number; recheckAfterHours?: number } = {},
): Promise<{ checked: number; found: number; missing: number; errored: number }> {
  const limit = opts.limit ?? 10;
  const recheckAfterHours = opts.recheckAfterHours ?? 24;
  const cutoff = new Date(Date.now() - recheckAfterHours * 3600 * 1000).toISOString();

  const { data } = await supabase
    .from("deals")
    .select("id, workspace_id, placed_url, target_url, anchor_text, link_checked_at")
    .not("placed_url", "is", null)
    .or(`link_checked_at.is.null,link_checked_at.lt.${cutoff}`)
    .order("link_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  const rows = (data ?? []) as (VerifiableDeal & { workspace_id: string })[];
  const tally = { checked: 0, found: 0, missing: 0, errored: 0 };

  for (const row of rows) {
    const result = await verifyDealBacklink(supabase, row, {
      workspaceId: row.workspace_id,
    });
    if (result.status === "skipped") continue;
    tally.checked += 1;
    if (result.status === "found") tally.found += 1;
    else if (result.status === "missing") tally.missing += 1;
    else tally.errored += 1;
  }

  return tally;
}
