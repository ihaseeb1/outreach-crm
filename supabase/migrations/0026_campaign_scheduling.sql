-- Campaign scheduling: let a draft/paused campaign activate itself at a future time.
--
-- Flow: the UI "Schedule" button sets scheduled_activate_at on a draft/paused
-- campaign. Every engine tick runs activateDueScheduledCampaigns(), which flips
-- due campaigns to active (after the same preflight checks as a manual start)
-- and clears the timestamp. Cancelling the schedule just nulls the column.
-- The send window / send days are NEVER touched by scheduling.

alter table public.campaigns
  add column if not exists scheduled_activate_at timestamptz;

create index if not exists campaigns_scheduled_activate_idx
  on public.campaigns (scheduled_activate_at)
  where scheduled_activate_at is not null;
