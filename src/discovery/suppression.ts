import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeEmail } from "@/lib/email";
import type { SuppressionListEntry } from "@/types/db";

/**
 * Discovery-level suppression + cross-run dedupe.
 *
 * Two independent guards keep a run from surfacing sites the operator has
 * already ruled out:
 *   1. `suppression_list` — competitor / owned / manually-blocked domains and
 *      emails (a NEW table, separate from the outbound `suppressions` table so
 *      nothing here can affect canSend()).
 *   2. domains already discovered in a prior run — so re-running a niche does
 *      not re-list what you have already seen.
 *
 * The pure predicates are exported for tests; the DB loaders are best-effort
 * and return empty sets when migration 0016 has not been applied yet.
 */

export interface SuppressionSets {
  domains: Set<string>;
  emails: Set<string>;
}

export function emptySuppression(): SuppressionSets {
  return { domains: new Set(), emails: new Set() };
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** True when the domain is suppressed, or is a subdomain of a suppressed one. */
export function isDomainSuppressed(domain: string, sets: SuppressionSets): boolean {
  const d = normalizeDomain(domain);
  if (!d) return true;
  if (sets.domains.has(d)) return true;
  for (const suppressed of sets.domains) {
    if (d.endsWith(`.${suppressed}`)) return true;
  }
  return false;
}

export function isEmailSuppressed(email: string, sets: SuppressionSets): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  if (sets.emails.has(e)) return true;
  // An email whose domain is suppressed is suppressed too.
  const at = e.lastIndexOf("@");
  if (at !== -1) return isDomainSuppressed(e.slice(at + 1), sets);
  return false;
}

/** Loads the workspace suppression_list into domain/email sets. Best-effort. */
export async function loadSuppressionSets(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<SuppressionSets> {
  const sets = emptySuppression();
  try {
    const { data, error } = await supabase
      .from("suppression_list")
      .select("value, kind")
      .eq("workspace_id", workspaceId);
    if (error) return sets;
    for (const row of (data ?? []) as Pick<SuppressionListEntry, "value" | "kind">[]) {
      if (row.kind === "domain") sets.domains.add(normalizeDomain(row.value));
      else if (row.kind === "email") sets.emails.add(normalizeEmail(row.value));
    }
  } catch {
    // Table not there yet (pre-0016) — no suppression, safe default.
  }
  return sets;
}

/**
 * Root domains already discovered for this workspace, for cross-run dedupe.
 * `excludeRunId` skips the current run so re-processing it is still idempotent.
 * Best-effort and chunk-free: discovered_sites is small per workspace.
 */
export async function loadKnownDomains(
  supabase: SupabaseClient,
  workspaceId: string,
  options: { excludeRunId?: string } = {},
): Promise<Set<string>> {
  const known = new Set<string>();
  try {
    let query = supabase
      .from("discovered_sites")
      .select("root_domain, run_id")
      .eq("workspace_id", workspaceId);
    if (options.excludeRunId) query = query.neq("run_id", options.excludeRunId);
    const { data, error } = await query;
    if (error) return known;
    for (const row of (data ?? []) as { root_domain: string }[]) {
      known.add(normalizeDomain(row.root_domain));
    }
  } catch {
    // Pre-0016 — nothing known yet.
  }
  return known;
}
