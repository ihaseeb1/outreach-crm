-- 0010_scrape_job_soft_delete.sql
--
-- Deleting scrape jobs (spec §6). Soft delete, so an accidental delete is
-- recoverable: a deleted job keeps its row with `deleted_at` set and is hidden
-- from the list; the scrape cron hard-purges anything deleted more than 30 days
-- ago. The job's raw website rows are removed at delete time (contacts already
-- promoted from them are kept — contacts.website_id is `on delete set null`).
--
-- Deploy-safe: the app filters deleted jobs in JS and the delete route falls
-- back to a hard delete when this column is absent, so nothing breaks in the
-- window between deploying and applying this migration.

alter table public.scrape_jobs
  add column if not exists deleted_at timestamptz;

create index if not exists scrape_jobs_deleted_idx
  on public.scrape_jobs (deleted_at)
  where deleted_at is not null;
