-- 0008_worker_runs.sql
--
-- Durable record of every background-job invocation. Until now the cron result
-- lived only in the HTTP response and a console.error, so a tick that silently
-- stopped running was discovered days later by "nothing has sent." This table
-- is the heartbeat: each /api/cron/* route writes one row, and the dashboard
-- turns "no successful dispatch in N minutes" into a visible red banner.
--
-- Written best-effort by the service role (which bypasses RLS). The send path
-- never depends on it: a deploy landing before this migration just means the
-- inserts no-op and the banner does not render.

create table if not exists public.worker_runs (
  id           uuid primary key default gen_random_uuid(),
  -- Global (null) for the cron dispatcher, which runs across all workspaces.
  workspace_id uuid references public.workspaces(id) on delete cascade,
  job          text not null,
  ok           boolean not null default true,
  processed    integer not null default 0,
  skipped      integer not null default 0,
  failed       integer not null default 0,
  error        text,
  notes        jsonb not null default '[]'::jsonb,
  started_at   timestamptz,
  finished_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists worker_runs_job_time_idx
  on public.worker_runs (job, finished_at desc);

alter table public.worker_runs enable row level security;

-- Operational telemetry, not tenant data: a workspace member may read runs
-- (global rows carry a null workspace_id). All writes come from the service
-- role, so there is deliberately no insert/update/delete policy.
drop policy if exists worker_runs_select on public.worker_runs;
create policy worker_runs_select on public.worker_runs
  for select using (
    workspace_id is null or public.is_workspace_member(workspace_id)
  );
