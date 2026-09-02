-- =====================================================================
-- 0017 — Active-publisher crawl seeds (Feature 2, Phase 3).
--
-- Additive: three columns on discovered_sites that let the operator opt a
-- discovered publisher into author-crawling, and let the worker claim it
-- idempotently. Nothing else changes. Kept separate from 0016 so a database
-- that already applied 0016 upgrades cleanly.
-- =====================================================================

alter table public.discovered_sites
  add column if not exists author_crawl        boolean not null default false,
  add column if not exists authors_crawled_at  timestamptz,
  add column if not exists authors_found       integer not null default 0;

-- Partial index for the worker's claim query: sites opted in but not yet crawled.
create index if not exists discovered_sites_author_crawl_idx
  on public.discovered_sites (authors_crawled_at)
  where author_crawl and authors_crawled_at is null;
