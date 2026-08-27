-- 0012_link_placements.sql
--
-- Link-building placement tracker + live backlink verifier (spec §9). A deal
-- records the terms of a placement; these columns record the placement itself —
-- where the link actually went live, what it points at, and the anchor used —
-- plus the verdict of fetching that page and checking the link is really there.
--
-- The verifier fetches `placed_url`, looks for an <a> to `target_url`, and
-- writes `link_status` (found / missing / error), whether it is dofollow, and a
-- human-readable detail. Re-checked periodically by the backlinks cron so a
-- publisher quietly pulling or nofollowing a paid link is caught.
--
-- Deploy-safe: readers probe for these columns before using them and the
-- backlinks cron try/catches its query, so nothing breaks before this is applied.

alter table public.deals
  add column if not exists placed_url        text,
  add column if not exists target_url        text,
  add column if not exists anchor_text       text,
  add column if not exists link_status       text not null default 'unchecked'
    check (link_status in ('unchecked', 'found', 'missing', 'error')),
  add column if not exists link_is_dofollow  boolean,
  add column if not exists link_checked_at   timestamptz,
  add column if not exists link_detail       text;

comment on column public.deals.placed_url is
  'Live URL where the backlink was placed (spec §9); the verifier fetches this.';
comment on column public.deals.target_url is
  'The page on our site the placed link should point at.';
comment on column public.deals.link_status is
  'Verifier verdict: unchecked / found / missing / error.';

-- The cron verifies the oldest-checked placements first; this index makes
-- "placements with a URL, least-recently checked" cheap.
create index if not exists deals_backlink_check_idx
  on public.deals (workspace_id, link_checked_at nulls first)
  where placed_url is not null;
