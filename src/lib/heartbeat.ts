import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The worker heartbeat (spec §9 reliability).
 *
 * `recordWorkerRun` is called by every /api/cron/* route; `readHeartbeat` tells
 * the dashboard how long it has been since the send dispatcher last ran. Both
 * are best-effort and never throw — a missing 0008 migration or a transient
 * error must never break a cron job or crash a page render.
 */

export interface WorkerRunEntry {
  job: string;
  ok: boolean;
  processed?: number;
  skipped?: number;
  failed?: number;
  error?: string | null;
  notes?: unknown[];
  /** ISO string when the job began, for measuring how long it took. */
  startedAt?: string | null;
}

export async function recordWorkerRun(
  supabase: SupabaseClient,
  entry: WorkerRunEntry,
): Promise<void> {
  try {
    await supabase.from("worker_runs").insert({
      job: entry.job,
      ok: entry.ok,
      processed: entry.processed ?? 0,
      skipped: entry.skipped ?? 0,
      failed: entry.failed ?? 0,
      error: entry.error ?? null,
      notes: entry.notes ?? [],
      started_at: entry.startedAt ?? null,
    });
  } catch {
    // Telemetry is never allowed to break the job it is measuring.
  }
}

export interface Heartbeat {
  job: string;
  lastRunAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  lastOk: boolean;
  staleMinutes: number;
}

/**
 * Freshness of one job (the campaign send dispatcher by default). Returns null
 * when the table is unavailable — the caller then simply shows no banner rather
 * than failing. A default staleness of 90 minutes is three missed 30-minute
 * ticks, well past ordinary scheduling jitter.
 */
export async function readHeartbeat(
  supabase: SupabaseClient,
  options: { job?: string; staleMinutes?: number } = {},
): Promise<Heartbeat | null> {
  const job = options.job ?? "campaigns";
  const staleMinutes = options.staleMinutes ?? 90;

  try {
    const { data, error } = await supabase
      .from("worker_runs")
      .select("job, ok, finished_at")
      .eq("job", job)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return null;
    if (!data) {
      return {
        job,
        lastRunAt: null,
        ageMinutes: null,
        stale: true,
        lastOk: false,
        staleMinutes,
      };
    }

    const row = data as { job: string; ok: boolean; finished_at: string };
    const ageMinutes = Math.max(
      0,
      Math.round((Date.now() - Date.parse(row.finished_at)) / 60000),
    );

    return {
      job,
      lastRunAt: row.finished_at,
      ageMinutes,
      stale: ageMinutes > staleMinutes,
      lastOk: row.ok,
      staleMinutes,
    };
  } catch {
    return null;
  }
}
