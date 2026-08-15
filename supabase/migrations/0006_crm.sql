-- =====================================================================
-- 0006 — CRM: configurable pipeline, notes, tasks.
--
-- `contacts.pipeline_stage` already exists as free text; it now references a
-- stage key that each workspace configures for itself.
-- =====================================================================

create table public.pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key          text not null,
  label        text not null,
  position     integer not null default 0,
  color        text not null default 'gray',
  -- Terminal stages, used for reporting in phase 7.
  is_won       boolean not null default false,
  is_lost      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, key)
);

create index pipeline_stages_workspace_idx
  on public.pipeline_stages (workspace_id, position);

create table public.notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id   uuid references public.contacts (id) on delete cascade,
  domain       text,
  author_id    uuid references auth.users (id) on delete set null,
  body         text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index notes_contact_idx on public.notes (contact_id, created_at desc);
create index notes_domain_idx on public.notes (workspace_id, domain);

create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  contact_id   uuid references public.contacts (id) on delete cascade,
  deal_id      uuid references public.deals (id) on delete set null,
  title        text not null,
  details      text,
  due_date     date,
  done         boolean not null default false,
  done_at      timestamptz,
  assigned_to  uuid references auth.users (id) on delete set null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tasks_workspace_idx on public.tasks (workspace_id, done, due_date);
create index tasks_contact_idx on public.tasks (contact_id);

/**
 * Seeds a workspace's default pipeline. Mirrors how link-building outreach
 * actually progresses, and is fully editable afterwards.
 */
create or replace function public.seed_pipeline_stages(ws uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.pipeline_stages (workspace_id, key, label, position, color, is_won, is_lost)
  values
    (ws, 'new',         'New',          0, 'gray',   false, false),
    (ws, 'contacted',   'Contacted',    1, 'blue',   false, false),
    (ws, 'replied',     'Replied',      2, 'indigo', false, false),
    (ws, 'negotiating', 'Negotiating',  3, 'amber',  false, false),
    (ws, 'agreed',      'Agreed',       4, 'green',  false, false),
    (ws, 'live',        'Live',         5, 'green',  true,  false),
    (ws, 'rejected',    'Not a fit',    6, 'red',    false, true)
  on conflict (workspace_id, key) do nothing;
$$;

create or replace function public.seed_pipeline_on_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_pipeline_stages(new.id);
  return new;
end;
$$;

create trigger workspaces_seed_pipeline
  after insert on public.workspaces
  for each row execute function public.seed_pipeline_on_workspace();

-- Backfill for workspaces created before this migration.
do $$
declare
  ws record;
begin
  for ws in select id from public.workspaces loop
    perform public.seed_pipeline_stages(ws.id);
  end loop;
end;
$$;

create trigger pipeline_stages_set_updated_at before update on public.pipeline_stages for each row execute function public.set_updated_at();
create trigger notes_set_updated_at           before update on public.notes           for each row execute function public.set_updated_at();
create trigger tasks_set_updated_at           before update on public.tasks           for each row execute function public.set_updated_at();

alter table public.pipeline_stages enable row level security;
alter table public.notes           enable row level security;
alter table public.tasks           enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['pipeline_stages', 'notes', 'tasks']
  loop
    execute format(
      'create policy %I on public.%I for select using (public.is_workspace_member(workspace_id));',
      t || ': member select', t);
    execute format(
      'create policy %I on public.%I for insert with check (public.is_workspace_member(workspace_id));',
      t || ': member insert', t);
    execute format(
      'create policy %I on public.%I for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));',
      t || ': member update', t);
    execute format(
      'create policy %I on public.%I for delete using (public.is_workspace_member(workspace_id));',
      t || ': member delete', t);
  end loop;
end;
$$;

/**
 * Per-domain rollup. A publisher usually has several addresses, and what you
 * care about is the site, not whichever inbox happened to answer.
 */
create or replace view public.domain_summary as
select
  c.workspace_id,
  c.domain,
  count(distinct c.id)                                          as contacts,
  max(conv.last_message_at)                                     as last_message_at,
  count(distinct d.id)                                          as deals,
  bool_or(d.status in ('agreed', 'ordered', 'live'))            as has_active_deal,
  min(dp.price) filter (where dp.price is not null)             as lowest_price
from public.contacts c
left join public.conversations conv on conv.contact_id = c.id
left join public.deals d on d.contact_id = c.id
left join public.deal_prices dp on dp.deal_id = d.id
where c.domain is not null
group by c.workspace_id, c.domain;

alter view public.domain_summary set (security_invoker = true);
