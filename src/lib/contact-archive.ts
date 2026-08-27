import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Contact soft-delete plumbing (spec §8).
 *
 * `contacts.archived_at` (migration 0011) hides a contact from the working list
 * without losing the record. Every reader must keep working in the window
 * between deploying this code and applying 0011, so we probe once whether the
 * column exists and only apply the archive predicate when it does — otherwise a
 * query referencing a missing column would 400 the whole page.
 */

// Once the column is confirmed present it cannot disappear, so a `true` result
// is cached for the process. A `false` result is not cached: a serverless
// instance that started just before the migration re-checks on the next call
// and picks the column up without a redeploy.
let columnPresent = false;

export async function archiveColumnExists(
  supabase: SupabaseClient,
): Promise<boolean> {
  if (columnPresent) return true;
  const { error } = await supabase.from("contacts").select("archived_at").limit(1);
  columnPresent = !error;
  return columnPresent;
}

export type ArchiveView = "active" | "archived" | "all";

/** Which slice of contacts the list is showing. Defaults to the working set. */
export function parseArchiveView(value: string | undefined): ArchiveView {
  return value === "archived" || value === "all" ? value : "active";
}
