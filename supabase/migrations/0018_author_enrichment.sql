-- =====================================================================
-- 0018 — Active-author enrichment claim column (Feature 2, Phase 4).
--
-- Additive: one nullable column on active_authors so the enrichment batch can
-- claim a row (enriched_at null -> now) and never re-scrape it. Nothing else
-- changes.
-- =====================================================================

alter table public.active_authors
  add column if not exists enriched_at timestamptz;

create index if not exists active_authors_enrich_idx
  on public.active_authors (created_at)
  where enriched_at is null;
