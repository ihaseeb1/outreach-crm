-- =====================================================================
-- 0001 — Core identity, prospecting, and the compliance core.
--
-- Phase 1 of the outreach/warmup/CRM platform.
--   * identity:    profiles, workspaces, workspace_members
--   * prospecting: websites, scrape_jobs, contacts
--   * compliance:  suppressions (the table canSend() consults), activity_log
--
-- Every table has RLS enabled and is scoped to a workspace the caller
-- belongs to. Background jobs use the service role, which bypasses RLS.
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.workspaces (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  owner_id                uuid not null references auth.users (id) on delete cascade,
  -- CAN-SPAM: required in every campaign footer. Campaigns cannot send until set.
  sending_postal_address  text,
  -- Bearer token for the read-only external API (GET /api/deals, phase 5).
  api_key                 text not null unique default encode(gen_random_bytes(24), 'hex'),
  settings                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index workspaces_owner_id_idx on public.workspaces (owner_id);

create table public.workspace_members (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx on public.workspace_members (user_id);

-- SECURITY DEFINER so RLS policies can call it without recursing into
-- workspace_members' own policies.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
  );
$$;

-- Every signup gets a profile, a workspace, and an owner membership.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ws_id uuid;
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;

  insert into public.workspaces (name, owner_id)
  values (
    coalesce(
      nullif(new.raw_user_meta_data ->> 'workspace_name', ''),
      split_part(new.email, '@', 1) || '''s workspace'
    ),
    new.id
  )
  returning id into ws_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws_id, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Prospecting
-- ---------------------------------------------------------------------

create table public.scrape_jobs (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  created_by        uuid references auth.users (id) on delete set null,
  input_urls        jsonb not null default '[]'::jsonb,
  status            text not null default 'pending'
                      check (status in ('pending', 'running', 'completed', 'failed')),
  total_count       integer not null default 0,
  processed_count   integer not null default 0,
  found_count       integer not null default 0,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index scrape_jobs_workspace_idx on public.scrape_jobs (workspace_id, created_at desc);
create index scrape_jobs_status_idx on public.scrape_jobs (status);

create table public.websites (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  scrape_job_id  uuid references public.scrape_jobs (id) on delete set null,
  url            text not null,
  domain         text not null,
  status         text not null default 'pending'
                   check (status in ('pending', 'scraping', 'done', 'failed', 'skipped_robots')),
  http_status    integer,
  emails_found   integer not null default 0,
  error          text,
  meta           jsonb not null default '{}'::jsonb,
  scraped_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, url)
);

create index websites_workspace_idx on public.websites (workspace_id, created_at desc);
create index websites_status_idx on public.websites (status, created_at);
create index websites_domain_idx on public.websites (workspace_id, domain);

create table public.contacts (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  website_id         uuid references public.websites (id) on delete set null,
  email              citext not null,
  first_name         text,
  last_name          text,
  phone              text,
  website            text,
  domain             text,
  -- GDPR accountability: where this address came from and when.
  source_url         text,
  scraped_at         timestamptz,
  validation_status  text not null default 'unknown'
                       check (validation_status in (
                         'unknown', 'valid', 'invalid_syntax', 'no_mx',
                         'disposable', 'role_account', 'suppressed', 'bounced'
                       )),
  validated_at       timestamptz,
  pipeline_stage     text not null default 'new',
  tags               text[] not null default '{}',
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, email)
);

create index contacts_workspace_idx on public.contacts (workspace_id, created_at desc);
create index contacts_domain_idx on public.contacts (workspace_id, domain);
create index contacts_validation_idx on public.contacts (workspace_id, validation_status);
create index contacts_stage_idx on public.contacts (workspace_id, pipeline_stage);

-- ---------------------------------------------------------------------
-- Compliance core
-- ---------------------------------------------------------------------

-- The single source of truth for "never email this address again".
-- canSend() checks this before EVERY outbound message, campaign or warmup.
create table public.suppressions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  email         citext not null,
  reason        text not null default 'manual'
                  check (reason in ('unsubscribed', 'hard_bounce', 'complaint', 'manual', 'opted_out')),
  source        text,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (workspace_id, email)
);

create index suppressions_email_idx on public.suppressions (email);

create table public.activity_log (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  actor_id      uuid references auth.users (id) on delete set null,
  action        text not null,
  entity_type   text,
  entity_id     uuid,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index activity_log_workspace_idx on public.activity_log (workspace_id, created_at desc);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------

create trigger profiles_set_updated_at    before update on public.profiles    for each row execute function public.set_updated_at();
create trigger workspaces_set_updated_at  before update on public.workspaces  for each row execute function public.set_updated_at();
create trigger scrape_jobs_set_updated_at before update on public.scrape_jobs for each row execute function public.set_updated_at();
create trigger websites_set_updated_at    before update on public.websites    for each row execute function public.set_updated_at();
create trigger contacts_set_updated_at    before update on public.contacts    for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.scrape_jobs       enable row level security;
alter table public.websites          enable row level security;
alter table public.contacts          enable row level security;
alter table public.suppressions      enable row level security;
alter table public.activity_log      enable row level security;

create policy "profiles: self read"   on public.profiles for select using (id = auth.uid());
create policy "profiles: self update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy "workspaces: member read"  on public.workspaces for select using (public.is_workspace_member(id));
create policy "workspaces: owner update" on public.workspaces for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "workspace_members: self read" on public.workspace_members for select using (user_id = auth.uid());

-- Workspace-scoped tables: identical member-only policy for all four verbs.
do $$
declare
  t text;
begin
  foreach t in array array['scrape_jobs', 'websites', 'contacts', 'suppressions', 'activity_log']
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
