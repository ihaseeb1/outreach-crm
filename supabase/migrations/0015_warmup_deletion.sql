-- =====================================================================
-- 0015 — Warmup email auto-deletion.
--
-- Warmup outbound sends land in `messages` alongside real outreach (sendEmail
-- inserts every kind, tagging warmup only as `meta.kind = 'warmup'` — untyped
-- JSON). This migration gives warmup a real, indexable flag so it can be found
-- and expired reliably, plus a soft-delete column so a mistake is recoverable.
--
-- THE SAFETY RULE lives in application code (src/warmup/deletion.ts), not here:
-- a row is warmup ONLY when BOTH the sender AND every recipient is one of your
-- own connected mailboxes (the warmup pool). If either side is an external
-- address — a real publisher/webmaster — it is never warmup and is never
-- touched. `is_warmup` is set two ways, both fail-safe: at insertion (warmup
-- engine) and by a pool-membership backfill (scripts/backfill-warmup-flag.ts).
--
-- Deletion itself is OFF by default and gated on a workspace setting
-- (`settings.warmup.auto_delete_enabled`), so applying this migration changes
-- nothing on its own — it only lets the flag exist and the review report run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- messages: the warmup flag + soft delete
-- ---------------------------------------------------------------------

alter table public.messages
  add column if not exists is_warmup  boolean not null default false,
  -- Soft delete. The purge sets this first; a later pass hard-deletes rows that
  -- have sat soft-deleted past the grace period, so an over-eager run is
  -- recoverable until then.
  add column if not exists deleted_at timestamptz;

-- The purge scans by (workspace, is_warmup, sent_at); a partial index keeps that
-- cheap and never grows for the outreach rows, which are the overwhelming
-- majority and all have is_warmup = false.
create index if not exists messages_warmup_purge_idx
  on public.messages (workspace_id, sent_at)
  where is_warmup and deleted_at is null;

-- The hard-delete pass reads only soft-deleted rows.
create index if not exists messages_soft_deleted_idx
  on public.messages (deleted_at)
  where deleted_at is not null;

-- Every existing reader of `messages` selects specific columns or `*`; a new
-- column defaulting false / null cannot change any current query's meaning, and
-- the grants below re-extend column-level SELECT to the two new columns.
grant select (is_warmup, deleted_at) on public.messages to authenticated;

-- ---------------------------------------------------------------------
-- Per-mailbox retention override
-- ---------------------------------------------------------------------

-- Retention is resolved as: this per-mailbox value, else the workspace default
-- (settings.warmup.delete_after), else '7d'. Null means "inherit". The values
-- match RetentionRule in src/warmup/deletion.ts.
alter table public.warmup_settings
  add column if not exists delete_after text
    check (delete_after is null or delete_after in ('today', '7d', '14d'));

-- ---------------------------------------------------------------------
-- Mailbox purge rotation clock
-- ---------------------------------------------------------------------

-- The mailbox (IMAP) side of the purge is expensive — it opens a connection per
-- mailbox — so it runs at most once a day per mailbox, least-recently-purged
-- first, exactly like last_engaged_at rotates warmup engagement. The cheap
-- DB-only pass runs every tick regardless. Absent column => "never purged" =>
-- always due, so the rotation still works before this migration lands.
alter table public.mailboxes
  add column if not exists last_purged_at timestamptz;

-- No RLS changes: messages / warmup_settings / mailboxes already enforce
-- is_workspace_member, and only the service-role purge job writes these columns.
