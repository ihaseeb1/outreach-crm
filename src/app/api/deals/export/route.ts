import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { buildExportGrid, gridToCsv, gridToTsv } from "@/deals/export";
import {
  contactEmailMap,
  dealMailboxMap,
  filterByMailbox,
  loadDeals,
  parseDealFilters,
} from "@/deals/query";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Rate-card export. `format=xlsx` (default) downloads a real spreadsheet;
 * `csv` and `tsv` are there for pasting or piping elsewhere.
 *
 * Honours the same filters as the deals table, so what you see is what you get.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const format = (params.get("format") ?? "xlsx").toLowerCase();

  const filters = parseDealFilters(params);

  const supabase = await createSupabaseServerClient();
  const loaded = await loadDeals(supabase, session.workspace.id, filters);

  const mailboxByDeal = await dealMailboxMap(supabase, loaded);
  const deals = filterByMailbox(loaded, mailboxByDeal, filters.mailboxId);

  const [emails, { data: mailboxRows }] = await Promise.all([
    contactEmailMap(supabase, deals),
    supabase
      .from("mailboxes")
      .select("id, email")
      .eq("workspace_id", session.workspace.id),
  ]);

  const mailboxEmails = new Map(
    ((mailboxRows ?? []) as { id: string; email: string }[]).map((row) => [
      row.id,
      row.email,
    ]),
  );

  const grid = buildExportGrid(deals, {
    contactEmails: emails,
    // The spreadsheet is what gets sent to whoever is paying the invoices, and
    // "which of our addresses agreed this" is the first thing they ask.
    dealMailboxes: new Map(
      [...mailboxByDeal].map(([dealId, mailboxId]) => [
        dealId,
        mailboxEmails.get(mailboxId) ?? mailboxId,
      ]),
    ),
  });

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "tsv") {
    return new NextResponse(gridToTsv(grid), {
      headers: { "content-type": "text/tab-separated-values; charset=utf-8" },
    });
  }

  if (format === "csv") {
    // BOM so Excel opens UTF-8 correctly on Windows.
    return new NextResponse(`﻿${gridToCsv(grid)}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="deals-${stamp}.csv"`,
      },
    });
  }

  const sheet = XLSX.utils.aoa_to_sheet([grid.headers, ...grid.rows]);
  sheet["!cols"] = grid.headers.map((header) => ({
    wch: Math.min(40, Math.max(10, header.length + 2)),
  }));
  // Freeze the header row so a long rate card stays readable while scrolling.
  sheet["!freeze"] = { xSplit: "0", ySplit: "1" };

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Deals");

  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="deals-${stamp}.xlsx"`,
    },
  });
}
