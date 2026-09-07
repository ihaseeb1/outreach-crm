-- =====================================================================
-- 0021 — Client-acquisition lead sourcing.
--
-- Find potential CLIENTS by industry + location (e.g. "dentists in Texas"),
-- then feed them into the existing prospecting pipeline: a lead run searches
-- keyless engines with business-finding queries, collects business domains,
-- and queues them as `websites` (the same rows the scrape cron consumes) so the
-- scraper extracts contact emails and the operator can cold-email them.
--
-- Strictly ADDITIVE — one new table, no change to any existing table, policy or
-- job. Deploy-safe: the lead page/API probe for this table and no-op until it
-- exists.
-- =====================================================================

create table if not exists public.lead_runs (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  created_by        uuid references auth.users (id) on delete set null,
  -- What and where: "dentists", "Texas".
  industry          text not null,
  location          text,
  -- ISO-3166 alpha-2, or 'WORLDWIDE' (no geo bias) — matches discovery_runs.
  geo               text not null default 'WORLDWIDE',
  -- The expanded query list actually run (industry × location × modifiers).
  queries           jsonb not null default '[]'::jsonb,
  engines           text[] not null default '{}',
  status            text not null default 'pending'
                      check (status in ('pending', 'running', 'completed', 'failed')),
  total_queries     integer not null default 0,
  processed_queries integer not null default 0,
  -- Business domains queued into the prospecting `websites` table.
  found_count       integer not null default 0,
  -- The scrape_job the queued websites belong to, for the "view in Prospecting"
  -- link.
  scrape_job_id     uuid references public.scrape_jobs (id) on delete set null,
  error             text,
  settings          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index if not exists lead_runs_workspace_idx
  on public.lead_runs (workspace_id, created_at desc);
create index if not exists lead_runs_status_idx
  on public.lead_runs (status);

drop trigger if exists lead_runs_set_updated_at on public.lead_runs;
create trigger lead_runs_set_updated_at
  before update on public.lead_runs
  for each row execute function public.set_updated_at();

alter table public.lead_runs enable row level security;

do $$
begin
  execute 'create policy "lead_runs: member select" on public.lead_runs for select using (public.is_workspace_member(workspace_id));';
  execute 'create policy "lead_runs: member insert" on public.lead_runs for insert with check (public.is_workspace_member(workspace_id));';
  execute 'create policy "lead_runs: member update" on public.lead_runs for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));';
  execute 'create policy "lead_runs: member delete" on public.lead_runs for delete using (public.is_workspace_member(workspace_id));';
exception
  when duplicate_object then null;
end;
$$;
