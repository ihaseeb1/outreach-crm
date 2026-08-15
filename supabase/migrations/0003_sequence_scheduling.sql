-- =====================================================================
-- 0003 — Sequence scheduling.
--
-- Adds the bookkeeping the campaign runner needs: a claim lock so overlapping
-- cron ticks cannot double-send a step, plus per-contact error/attempt tracking.
-- =====================================================================

alter table public.campaign_contacts
  add column locked_until timestamptz,
  add column attempts     integer not null default 0,
  add column last_error   text;

-- The runner picks work with: status due AND (locked_until is null or expired).
create index campaign_contacts_claim_idx
  on public.campaign_contacts (next_send_at)
  where status in ('pending', 'active');

/**
 * Atomically claims a campaign contact for sending.
 *
 * Returns true only for the caller that wins the row. The lock self-expires so
 * a function that times out mid-send cannot strand a contact forever.
 */
create or replace function public.campaign_contact_claim(
  contact_row uuid,
  lock_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  update public.campaign_contacts
     set locked_until = now() + make_interval(secs => lock_seconds),
         attempts = attempts + 1
   where id = contact_row
     and status in ('pending', 'active')
     and (locked_until is null or locked_until < now());

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

create or replace function public.campaign_contact_release(contact_row uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.campaign_contacts set locked_until = null where id = contact_row;
$$;

/**
 * Per-campaign counters for the UI, computed in one query rather than N.
 */
create or replace view public.campaign_stats as
select
  c.id                                                          as campaign_id,
  c.workspace_id,
  count(cc.id)                                                  as total_contacts,
  count(*) filter (where cc.status = 'pending')                 as pending,
  count(*) filter (where cc.status = 'active')                  as active,
  count(*) filter (where cc.status = 'replied')                 as replied,
  count(*) filter (where cc.status = 'completed')               as completed,
  count(*) filter (where cc.status = 'bounced')                 as bounced,
  count(*) filter (where cc.status = 'unsubscribed')            as unsubscribed,
  count(*) filter (where cc.status = 'paused')                  as paused,
  count(*) filter (where cc.status = 'failed')                  as failed
from public.campaigns c
left join public.campaign_contacts cc on cc.campaign_id = c.id
group by c.id, c.workspace_id;

-- Views run with the querying user's permissions in PG15+ when declared
-- security_invoker, so the underlying RLS policies still apply.
alter view public.campaign_stats set (security_invoker = true);
