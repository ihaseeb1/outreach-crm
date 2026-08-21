import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which contacts are already spoken for, and by which campaign.
 *
 * A new campaign asking for "the newest 100 validated contacts" used to get
 * exactly that — including the 56 already enrolled in First Campaign, which is
 * how 100 contacts were added to a second campaign without one of them being
 * new. Nothing in the enrolment path looked outside the campaign being added
 * to: it checked "is this contact already in *this* campaign", which is a
 * different question from "has this contact been used".
 *
 * Any row in `campaign_contacts` counts as used, whatever its status. Pending,
 * mid-sequence, completed, bounced, opted out — all of them mean this person
 * has been (or is about to be) written to, and emailing them again from a
 * second campaign is the duplicate the user is trying to avoid.
 */

export interface EnrolmentElsewhere {
  campaignId: string;
  campaignName: string;
  status: string;
}

/** contact_id -> every campaign it is enrolled in. */
export type EnrolmentIndex = Map<string, EnrolmentElsewhere[]>;

interface EnrolmentRow {
  contact_id: string;
  campaign_id: string;
  status: string;
  campaigns: { name: string } | { name: string }[] | null;
}

/** PostgREST returns a to-one embed as an object, or an array when it cannot prove uniqueness. */
function campaignName(row: EnrolmentRow): string {
  const embedded = Array.isArray(row.campaigns) ? row.campaigns[0] : row.campaigns;
  return embedded?.name ?? "another campaign";
}

/**
 * Loads enrolments for a set of contacts, or for the whole workspace.
 *
 * Pass `contactIds` when the candidates are known — that is one indexed lookup
 * instead of reading every enrolment in the workspace. Omit it to build the
 * full index, which is what the filtered "add matching contacts" path needs
 * before it can decide which contacts even qualify.
 */
export async function loadEnrolments(
  supabase: SupabaseClient,
  workspaceId: string,
  options: { contactIds?: string[]; limit?: number } = {},
): Promise<EnrolmentIndex> {
  const index: EnrolmentIndex = new Map();
  if (options.contactIds && options.contactIds.length === 0) return index;

  const pageSize = 1000;
  const ceiling = options.limit ?? 50_000;

  const collect = (rows: EnrolmentRow[]) => {
    for (const row of rows) {
      if (!row.contact_id) continue;
      const list = index.get(row.contact_id) ?? [];
      list.push({
        campaignId: row.campaign_id,
        campaignName: campaignName(row),
        status: row.status,
      });
      index.set(row.contact_id, list);
    }
  };

  const select = () =>
    supabase
      .from("campaign_contacts")
      .select("contact_id, campaign_id, status, campaigns(name)")
      .eq("workspace_id", workspaceId);

  if (options.contactIds) {
    // Chunked, because `in` becomes a query string: five thousand uuids is a
    // 180KB URL, which the gateway rejects long before Postgres sees it. A
    // contact can be in several campaigns, so the row limit per chunk is
    // deliberately well above the chunk size.
    const CHUNK = 200;
    for (let i = 0; i < options.contactIds.length; i += CHUNK) {
      const chunk = options.contactIds.slice(i, i + CHUNK);
      const { data } = await select().in("contact_id", chunk).limit(pageSize * 2);
      collect((data ?? []) as unknown as EnrolmentRow[]);
    }
    return index;
  }

  for (let from = 0; from < ceiling; from += pageSize) {
    const { data } = await select()
      .order("contact_id", { ascending: true })
      .range(from, Math.min(from + pageSize, ceiling) - 1);

    const rows = (data ?? []) as unknown as EnrolmentRow[];
    collect(rows);
    if (rows.length < pageSize) break;
  }

  return index;
}

/**
 * Counts the exclusions per campaign, biggest first.
 *
 * Pure so it can be tested, and so the same numbers can be shown by the
 * enrolment form, written to the activity log, and returned by the API without
 * three chances to count differently. A contact in two campaigns is counted
 * once for each — "which campaigns are holding these contacts" is the question,
 * not "how many contacts".
 */
export function summariseByCampaign(
  entries: EnrolmentElsewhere[][],
): { campaign: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const list of entries) {
    // Two rows for the same contact in the same campaign cannot happen (the
    // table has a unique key), so no dedupe is needed inside one list.
    for (const entry of list) {
      counts.set(entry.campaignName, (counts.get(entry.campaignName) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([campaign, count]) => ({ campaign, count }))
    .sort((a, b) => b.count - a.count || a.campaign.localeCompare(b.campaign));
}

/**
 * "12 already in First Campaign, 3 in Outreach Q3" — the sentence the user
 * asked for. Names the campaigns rather than reporting a bare number, because
 * the first thing anyone wants to know is where the contacts went.
 */
export function describeExclusions(
  summary: { campaign: string; count: number }[],
  max = 4,
): string {
  if (summary.length === 0) return "";
  const shown = summary
    .slice(0, max)
    .map((entry) => `${entry.count} in ${entry.campaign}`);
  const rest = summary.length - max;
  if (rest > 0) shown.push(`and ${rest} other campaign${rest === 1 ? "" : "s"}`);
  return shown.join(", ");
}

/**
 * Adds two per-campaign summaries together.
 *
 * The filtered "add matching contacts" path drops used contacts before
 * enrolment ever sees them, and enrolment drops any that slip through by id, so
 * the exclusions are counted in two places and have to be reported as one
 * sentence.
 */
export function mergeSummaries(
  ...summaries: { campaign: string; count: number }[][]
): { campaign: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    for (const entry of summary) {
      counts.set(entry.campaign, (counts.get(entry.campaign) ?? 0) + entry.count);
    }
  }
  return [...counts.entries()]
    .map(([campaign, count]) => ({ campaign, count }))
    .sort((a, b) => b.count - a.count || a.campaign.localeCompare(b.campaign));
}
