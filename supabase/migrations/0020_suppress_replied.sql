-- 0020_suppress_replied.sql
--
-- Auto-suppress repliers. When a contact replies, mail/inbound.ts now adds them
-- to the global suppression list with reason 'replied', so no future campaign
-- can cold-email someone who already answered (pausing the current sequence
-- only stopped that one campaign). This widens the reason CHECK to allow it.
--
-- Deploy-safe either way: the app change no-ops the insert if this hasn't run,
-- and this migration is a pure constraint widening.

alter table public.suppressions
  drop constraint if exists suppressions_reason_check;

alter table public.suppressions
  add constraint suppressions_reason_check
  check (reason in (
    'unsubscribed', 'hard_bounce', 'complaint', 'manual', 'opted_out', 'replied'
  ));

-- Backfill: retire every existing replier from the cold-sending pool. Skips
-- your own connected mailboxes (a warmup/self reply must never be suppressed)
-- and anyone already suppressed.
insert into public.suppressions (workspace_id, email, reason, source)
select distinct cc.workspace_id, c.email, 'replied', 'backfill:reply'
from public.campaign_contacts cc
join public.contacts c on c.id = cc.contact_id
where cc.status = 'replied'
  and c.email is not null
  and not exists (
    select 1 from public.mailboxes m
    where m.workspace_id = cc.workspace_id and m.email = c.email
  )
on conflict (workspace_id, email) do nothing;
