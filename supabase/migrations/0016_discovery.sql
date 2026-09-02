-- =====================================================================
-- 0016 — Discovery & Prospecting (zero-cost stack).
--
-- Two new features, both strictly ADDITIVE — nothing here alters an
-- existing table, policy, or job:
--   * Feature 1 — SERP guest-post discovery: discovery_runs, discovered_sites
--   * Feature 2 — active-publisher targeting: active_authors
--   * plumbing: crawl_cache (polite-crawl cache), suppression_list
--                (discovery-level domain/email blacklist, separate from the
--                 outbound `suppressions` table canSend() consults).
--
-- Every workspace-scoped table has RLS enabled with the same member-only
-- policy the rest of the schema uses. Background jobs use the service role,
-- which bypasses RLS. Migrations 0001–0015 are unchanged.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Feature 1 — SERP guest-post discovery
-- ---------------------------------------------------------------------

-- One discovery run = one "footprints × niche → search" sweep.
create table if not exists public.discovery_runs (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  created_by        uuid references auth.users (id) on delete set null,
  niche             text not null,
  -- The expanded query list actually run (footprints × niche synonyms).
  queries           jsonb not null default '[]'::jsonb,
  -- ISO-3166 alpha-2, or 'WORLDWIDE' (no geo bias).
  geo               text not null default 'WORLDWIDE',
  -- Engines used for this run, e.g. ['duckduckgo'].
  engines           text[] not null default '{}',
  status            text not null default 'pending'
                      check (status in ('pending', 'running', 'completed', 'failed')),
  total_queries     integer not null default 0,
  processed_queries integer not null default 0,
  found_count       integer not null default 0,
  error             text,
  settings          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index if not exists discovery_runs_workspace_idx
  on public.discovery_runs (workspace_id, created_at desc);
create index if not exists discovery_runs_status_idx
  on public.discovery_runs (status);

-- One candidate publisher site found by a run.
create table if not exists public.discovered_sites (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  run_id             uuid not null references public.discovery_runs (id) on delete cascade,
  root_domain        text not null,
  -- The SERP result URL (usually the write-for-us / guest-post page).
  guest_post_url     text,
  matched_footprint  text,
  best_position      integer,
  title              text,
  description        text,
  -- Free-signal 0–100 quality score (see src/discovery/score/opportunity.ts).
  opportunity_score  numeric,
  -- Publishing cadence in days, derived from sitemap <lastmod> when available.
  post_cadence_days  numeric,
  has_contact_info   boolean not null default false,
  -- Relationship pipeline for the outreach lifecycle.
  status             text not null default 'new'
                       check (status in ('new', 'contacted', 'replied', 'published', 'won')),
  -- Set once the site has been pushed into the existing prospecting queue.
  pushed_website_id  uuid references public.websites (id) on delete set null,
  pushed_at          timestamptz,
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (run_id, root_domain)
);

create index if not exists discovered_sites_workspace_idx
  on public.discovered_sites (workspace_id, created_at desc);
create index if not exists discovered_sites_run_idx
  on public.discovered_sites (run_id, opportunity_score desc nulls last);
create index if not exists discovered_sites_domain_idx
  on public.discovered_sites (workspace_id, root_domain);

-- ---------------------------------------------------------------------
-- Feature 2 — active-publisher targeting
-- ---------------------------------------------------------------------

-- An author who published a guest post recently, plus their resolved
-- destination ("money") site and self-scraped contact details.
create table if not exists public.active_authors (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  -- The publisher site that ran the guest post.
  source_domain      text not null,
  source_post_url    text not null,
  author_name        text,
  -- Where the author's bio link points — their own site.
  destination_domain text not null,
  published_at       timestamptz,
  -- How confidently this reads as a guest post (0–100).
  detection_score    numeric,
  -- Recency-weighted score so a 2-day-old post outranks a 25-day-old one.
  freshness_score    numeric,
  latest_post_title  text,
  latest_post_topic  text,
  -- Self-scraped enrichment (Phase 4).
  email              text,
  email_status       text not null default 'unknown'
                       check (email_status in (
                         'unknown', 'verified', 'invalid_syntax', 'no_mx',
                         'disposable', 'role_account', 'unverified'
                       )),
  phone              text,
  phone_region       text,
  contact_confidence numeric,
  status             text not null default 'new'
                       check (status in ('new', 'contacted', 'replied', 'published', 'won')),
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, source_post_url, destination_domain)
);

create index if not exists active_authors_workspace_idx
  on public.active_authors (workspace_id, created_at desc);
create index if not exists active_authors_freshness_idx
  on public.active_authors (workspace_id, freshness_score desc nulls last);
create index if not exists active_authors_dest_idx
  on public.active_authors (workspace_id, destination_domain);

-- ---------------------------------------------------------------------
-- Polite-crawl cache (shared across workspaces — pages are public web
-- content, not tenant data). RLS on with no member policy means only the
-- service-role worker can read/write it.
-- ---------------------------------------------------------------------

create table if not exists public.crawl_cache (
  url          text primary key,
  status_int   integer,
  body         text,
  fetched_at   timestamptz not null default now(),
  ttl_seconds  integer not null default 604800   -- 7 days
);

create index if not exists crawl_cache_fetched_idx on public.crawl_cache (fetched_at);

-- ---------------------------------------------------------------------
-- Discovery-level suppression / blacklist (never contact / already own).
-- Kept separate from the outbound `suppressions` table so nothing here can
-- affect canSend(); this one filters discovery + publisher results and
-- supports whole-domain entries.
-- ---------------------------------------------------------------------

create table if not exists public.suppression_list (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  value         text not null,                 -- domain or email, normalized
  kind          text not null check (kind in ('domain', 'email')),
  reason        text not null default 'manual'
                  check (reason in ('competitor', 'owned', 'unsubscribed', 'bounced', 'manual')),
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (workspace_id, value)
);

create index if not exists suppression_list_workspace_idx
  on public.suppression_list (workspace_id, kind);

-- ---------------------------------------------------------------------
-- updated_at triggers (reuses the existing public.set_updated_at()).
-- ---------------------------------------------------------------------

drop trigger if exists discovery_runs_set_updated_at on public.discovery_runs;
create trigger discovery_runs_set_updated_at
  before update on public.discovery_runs
  for each row execute function public.set_updated_at();

drop trigger if exists discovered_sites_set_updated_at on public.discovered_sites;
create trigger discovered_sites_set_updated_at
  before update on public.discovered_sites
  for each row execute function public.set_updated_at();

drop trigger if exists active_authors_set_updated_at on public.active_authors;
create trigger active_authors_set_updated_at
  before update on public.active_authors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.discovery_runs    enable row level security;
alter table public.discovered_sites  enable row level security;
alter table public.active_authors    enable row level security;
alter table public.suppression_list  enable row level security;
-- crawl_cache: RLS on, no member policy -> only the service role touches it.
alter table public.crawl_cache        enable row level security;

-- Same member-only policy for all four verbs on the workspace-scoped tables.
do $$
declare
  t text;
begin
  foreach t in array array['discovery_runs', 'discovered_sites', 'active_authors', 'suppression_list']
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
