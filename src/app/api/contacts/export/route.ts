import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import type { Contact } from "@/types/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "phone",
  "domain",
  "website",
  "source_url",
  "validation_status",
  "pipeline_stage",
  "scraped_at",
  "created_at",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV export honouring the same filters as the contacts table. */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("contacts")
    .select(COLUMNS.join(","))
    .eq("workspace_id", session.workspace.id)
    .order("created_at", { ascending: false })
    .limit(50_000);

  const status = params.get("status");
  if (status) query = query.eq("validation_status", status);

  const stage = params.get("stage");
  if (stage) query = query.eq("pipeline_stage", stage);

  const domain = params.get("domain");
  if (domain) query = query.ilike("domain", `%${domain}%`);

  const search = params.get("q");
  if (search) query = query.ilike("email", `%${search}%`);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Contact[];
  const lines = [
    COLUMNS.join(","),
    ...rows.map((row) =>
      COLUMNS.map((column) => csvCell(row[column as keyof Contact])).join(","),
    ),
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(`﻿${lines.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contacts-${stamp}.csv"`,
    },
  });
}
