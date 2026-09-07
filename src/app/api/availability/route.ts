import { NextResponse } from "next/server";
import { z } from "zod";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import {
  buildVerdicts,
  parseDomainList,
  type AvailabilityHit,
} from "@/lib/availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  /** Raw pasted text (URLs / domains, any separators) OR a ready domain list. */
  input: z.string().max(200_000).optional(),
  domains: z.array(z.string().min(1).max(300)).max(5000).optional(),
});

const CHUNK = 200;

/**
 * Runs one `.in("<column>", chunk)` sweep across a table's domain column.
 * `run` returns the rows for a chunk (or [] — it swallows its own errors so a
 * table that predates a migration just contributes nothing).
 */
async function sweep<T>(
  domains: string[],
  run: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < domains.length; i += CHUNK) {
    rows.push(...(await run(domains.slice(i, i + CHUNK))));
  }
  return rows;
}

function push(map: Map<string, AvailabilityHit[]>, domain: string, hit: AvailabilityHit) {
  if (!domain) return;
  const list = map.get(domain) ?? [];
  // One hit per source per domain keeps the summary readable.
  if (!list.some((h) => h.source === hit.source && h.detail === hit.detail)) {
    list.push(hit);
    map.set(domain, list);
  }
}

/**
 * Checks a pasted list of websites against the whole workspace and reports which
 * are still available to work vs already in the pipeline (and where).
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const domains = parsed.data.domains?.length
    ? parseDomainList(parsed.data.domains.join("\n"))
    : parseDomainList(parsed.data.input ?? "");

  if (domains.length === 0) {
    return NextResponse.json(
      { error: "No valid domains found in the input." },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const ws = session.workspace.id;
  const hits = new Map<string, AvailabilityHit[]>();

  // Best-effort query: swallow errors so a table that predates a migration
  // (e.g. discovered_sites before 0016) simply contributes no hits.
  async function rows<T>(fn: () => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
    try {
      return (await fn()).data ?? [];
    } catch {
      return [];
    }
  }

  // Deals — the strongest signal: money is already on the table here.
  const deals = await sweep(domains, (chunk) =>
    rows<{ domain: string; status: string | null }>(() =>
      supabase.from("deals").select("domain, status").eq("workspace_id", ws).in("domain", chunk),
    ),
  );
  for (const d of deals) {
    push(hits, d.domain, { source: "deal", detail: `deal · ${d.status ?? "open"}` });
  }

  // Contacts — carry the outreach state (replied / suppressed / stage).
  const contacts = await sweep(domains, (chunk) =>
    rows<{ domain: string | null; pipeline_stage: string | null; validation_status: string | null }>(
      () =>
        supabase
          .from("contacts")
          .select("domain, pipeline_stage, validation_status")
          .eq("workspace_id", ws)
          .in("domain", chunk),
    ),
  );
  for (const c of contacts) {
    if (!c.domain) continue;
    let detail: string;
    if (c.pipeline_stage === "replied") detail = "replied";
    else if (c.validation_status === "suppressed") detail = "suppressed";
    else if (c.validation_status === "bounced") detail = "bounced";
    else detail = `contact · ${c.pipeline_stage ?? "new"}`;
    push(hits, c.domain, { source: "contact", detail });
  }

  // Prospecting queue.
  const websites = await sweep(domains, (chunk) =>
    rows<{ domain: string; status: string | null }>(() =>
      supabase.from("websites").select("domain, status").eq("workspace_id", ws).in("domain", chunk),
    ),
  );
  for (const w of websites) {
    push(hits, w.domain, { source: "website", detail: `prospecting · ${w.status ?? "pending"}` });
  }

  // Discovery results (best-effort — table may predate migration 0016).
  const discovered = await sweep(domains, (chunk) =>
    rows<{ root_domain: string; status: string | null }>(() =>
      supabase
        .from("discovered_sites")
        .select("root_domain, status")
        .eq("workspace_id", ws)
        .in("root_domain", chunk),
    ),
  );
  for (const s of discovered) {
    push(hits, s.root_domain, { source: "discovery", detail: `discovery · ${s.status ?? "new"}` });
  }

  // Publishers — match either the destination (money) site or the source site.
  for (const col of ["destination_domain", "source_domain"] as const) {
    const authors = await sweep(domains, (chunk) =>
      rows<Record<string, string | null>>(() =>
        supabase.from("active_authors").select(col).eq("workspace_id", ws).in(col, chunk),
      ),
    );
    for (const a of authors) {
      const dom = a[col];
      if (!dom) continue;
      push(hits, dom, {
        source: "publisher",
        detail: col === "destination_domain" ? "publisher · author site" : "publisher · source",
      });
    }
  }

  const verdicts = buildVerdicts(domains, hits);
  const available = verdicts.filter((v) => v.available).length;

  return NextResponse.json({
    ok: true,
    total: verdicts.length,
    available,
    notAvailable: verdicts.length - available,
    verdicts,
  });
}
