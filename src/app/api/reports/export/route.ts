import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/workspace";
import { loadReportData } from "@/reports/data";
import { MAX_REPORT_MAILBOX_WINDOW } from "@/mailboxes/volume";
import {
  parseReportBucket,
  parseReportRange,
  resolveReportRange,
} from "@/reports/ranges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV of the volume series for the current range — sent, replies and bounces per
 * bucket — so the numbers can be tracked outside the app. Uses the same uncapped
 * loader as the page, so the export is never clipped at 1000 rows either.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const range = resolveReportRange(
    parseReportRange(params.get("range")),
    new Date(),
    parseReportBucket(params.get("bucket")),
  );

  const supabase = await createSupabaseServerClient();
  const mailboxSince = new Date(
    Math.min(
      Date.parse(range.since),
      Date.now() - MAX_REPORT_MAILBOX_WINDOW * 86_400_000,
    ),
  ).toISOString();

  const report = await loadReportData(supabase, {
    workspaceId: session.workspace.id,
    since: range.since,
    days: range.days,
    bucket: range.bucket,
    mailboxSince,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const csv = (lines: string[], name: string) =>
    new NextResponse(`﻿${lines.join("\r\n")}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
      },
    });

  // Per-mailbox volume, split outreach vs warmup, across every window.
  if (params.get("type") === "mailboxes") {
    const { data: mailboxRows } = await supabase
      .from("mailboxes")
      .select("id, email")
      .eq("workspace_id", session.workspace.id)
      .order("created_at", { ascending: true });

    const windows = [7, 14, 30, 60, 90];
    const header = [
      "mailbox",
      "today_outreach",
      "today_warmup",
      ...windows.flatMap((days) => [`${days}d_outreach`, `${days}d_warmup`]),
    ];
    const lines = [header.join(",")];
    for (const mailbox of (mailboxRows ?? []) as { id: string; email: string }[]) {
      const volume = report.volumes[mailbox.id];
      const today = volume?.today ?? { outreach: 0, warmup: 0 };
      const cells: (string | number)[] = [mailbox.email, today.outreach, today.warmup];
      for (const days of windows) {
        const window = volume?.[days] ?? { outreach: 0, warmup: 0 };
        cells.push(window.outreach, window.warmup);
      }
      lines.push(cells.map(csvCell).join(","));
    }
    return csv(lines, `mailbox-stats-${stamp}.csv`);
  }

  const header = ["bucket_start", "bucket_end", "days", "sent", "replies", "bounces"];
  const lines = [
    header.join(","),
    ...report.series.map((point) =>
      [point.date, point.endDate, point.days, point.sent, point.replies, point.bounces]
        .map(csvCell)
        .join(","),
    ),
  ];
  return csv(lines, `reports-${range.key}-${stamp}.csv`);
}
