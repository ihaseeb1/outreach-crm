import { ActiveAuthorsTable, type AuthorRow } from "@/components/active-authors-table";
import { PublisherSeedForm } from "@/components/publisher-seed-form";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { ActiveAuthor } from "@/types/db";

export const dynamic = "force-dynamic";

const PAGE_LIMIT = 1000;

export default async function PublishersPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  // Best-effort: errors (and stays empty) until migrations 0016/0017 apply.
  const { data, error } = await supabase
    .from("active_authors")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("freshness_score", { ascending: false, nullsFirst: false })
    .limit(PAGE_LIMIT);

  const rows: AuthorRow[] = ((data ?? []) as ActiveAuthor[]).map((a) => ({
    id: a.id,
    author_name: a.author_name,
    source_domain: a.source_domain,
    source_post_url: a.source_post_url,
    destination_domain: a.destination_domain,
    published_at: a.published_at,
    detection_score: a.detection_score,
    freshness_score: a.freshness_score,
    latest_post_title: a.latest_post_title,
    email: a.email,
    email_status: a.email_status,
    phone: a.phone,
    phone_region: a.phone_region,
    status: a.status,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Active publishers</h1>
        <p className="hint mt-1">
          Guest authors who published in the last 30 days, with their resolved
          destination site. Enrich their contact details, then add the verified
          ones to a campaign.
        </p>
      </div>

      <PublisherSeedForm />

      {error && (
        <p className="card card-pad text-sm text-[var(--color-danger)]">
          Publisher tables aren&apos;t available yet — apply migrations{" "}
          <code>0016_discovery.sql</code> and <code>0017_publisher_crawl.sql</code>{" "}
          in Supabase, then reload.
        </p>
      )}

      <ActiveAuthorsTable rows={rows} />
    </div>
  );
}
