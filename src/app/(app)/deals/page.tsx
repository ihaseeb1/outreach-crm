import Link from "next/link";

import { DealRowActions } from "@/components/deal-row-actions";
import { DealsToolbar } from "@/components/deals-toolbar";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import { nicheColumns } from "@/deals/export";
import { contactEmailMap, loadDeals, parseDealFilters } from "@/deals/query";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  negotiating: "bg-gray-100 text-gray-700",
  agreed: "bg-blue-50 text-[var(--color-brand)]",
  ordered: "bg-amber-50 text-[var(--color-warn)]",
  live: "bg-green-50 text-[var(--color-ok)]",
  rejected: "bg-red-50 text-[var(--color-danger)]",
};

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value) search.set(key, value);
  }

  const supabase = await createSupabaseServerClient();
  const filters = parseDealFilters(search);
  const deals = await loadDeals(supabase, session.workspace.id, filters);
  const emails = await contactEmailMap(supabase, deals);
  const niches = nicheColumns(deals);

  const liveValue = deals
    .filter((deal) => deal.status === "live" || deal.status === "ordered")
    .reduce((sum, deal) => {
      const lowest = (deal.deal_prices ?? [])
        .map((price) => Number(price.price))
        .sort((a, b) => a - b)[0];
      return sum + (lowest ?? 0);
    }, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Deals</h1>
        <p className="hint mt-1">
          Publisher rate cards — {deals.length} matching, {liveValue.toLocaleString()}{" "}
          committed across ordered and live placements.
        </p>
      </div>

      <DealsToolbar query={search.toString()} />

      <form method="get" className="card card-pad grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <label className="label" htmlFor="domain">
            Domain
          </label>
          <input id="domain" name="domain" className="input" defaultValue={filters.domain ?? ""} />
        </div>
        <div>
          <label className="label" htmlFor="niche">
            Niche
          </label>
          <input id="niche" name="niche" className="input" defaultValue={filters.niche ?? ""} />
        </div>
        <div>
          <label className="label" htmlFor="min_price">
            Min price
          </label>
          <input
            id="min_price"
            name="min_price"
            className="input"
            type="number"
            defaultValue={filters.minPrice ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="max_price">
            Max price
          </label>
          <input
            id="max_price"
            name="max_price"
            className="input"
            type="number"
            defaultValue={filters.maxPrice ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="max_tat">
            Max TAT
          </label>
          <input
            id="max_tat"
            name="max_tat"
            className="input"
            type="number"
            defaultValue={filters.maxTat ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" className="input" defaultValue={filters.status ?? ""}>
            <option value="">All</option>
            {["negotiating", "agreed", "ordered", "live", "rejected"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2 sm:col-span-3">
          <button className="btn-primary" type="submit">
            Filter
          </button>
          <Link className="btn-secondary" href="/deals">
            Reset
          </Link>
        </div>
      </form>

      <section className="card">
        {deals.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">
            No deals yet. Open a reply in the{" "}
            <Link className="text-[var(--color-brand)] hover:underline" href="/inbox">
              Inbox
            </Link>{" "}
            and use <strong>Log deal</strong> to record what a publisher quoted.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Contact</th>
                  <th>Link</th>
                  <th>TAT</th>
                  <th>DR</th>
                  <th>Traffic</th>
                  {niches.map((niche) => (
                    <th key={niche}>{niche}</th>
                  ))}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal) => {
                  const priceByNiche = new Map(
                    (deal.deal_prices ?? []).map((price) => [
                      price.niche.trim(),
                      Number(price.price),
                    ]),
                  );
                  return (
                    <tr key={deal.id}>
                      <td className="font-medium">{deal.domain}</td>
                      <td>
                        <span className={`badge ${STATUS_STYLES[deal.status] ?? ""}`}>
                          {deal.status}
                        </span>
                      </td>
                      <td className="max-w-40 truncate">
                        {(deal.contact_id && emails.get(deal.contact_id)) || "—"}
                      </td>
                      <td>{deal.link_type ?? "—"}</td>
                      <td>{deal.tat_days ?? "—"}</td>
                      <td>{deal.dr ?? "—"}</td>
                      <td>{deal.monthly_traffic?.toLocaleString() ?? "—"}</td>
                      {niches.map((niche) => {
                        const price = priceByNiche.get(niche);
                        return (
                          <td key={niche}>
                            {price === undefined
                              ? "—"
                              : `${deal.currency} ${price.toLocaleString()}`}
                          </td>
                        );
                      })}
                      <td>
                        <DealRowActions deal={deal} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-pad space-y-2">
        <h2 className="text-sm font-semibold">Pull these into your portal</h2>
        <p className="hint">
          Read-only JSON, authenticated with the workspace API key from Settings.
          Accepts the same filters as this page.
        </p>
        <code className="block overflow-x-auto rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs">
          curl -H &quot;Authorization: Bearer &lt;api_key&gt;&quot;
          &quot;/api/deals?status=live&amp;niche=Casino&amp;max_price=500&quot;
        </code>
      </section>
    </div>
  );
}
