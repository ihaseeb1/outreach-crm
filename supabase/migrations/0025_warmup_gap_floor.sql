-- 0025_warmup_gap_floor.sql
--
-- Warmup bursts: mailbox_reserve_warmup (0014) never enforced an inter-send gap,
-- so parallel warmup ticks could fire several emails seconds apart (observed in
-- production: 3 sends from one mailbox within 2 seconds, and routine 0.0-minute
-- gaps). Campaigns got the same atomic fix in 0019; warmup needs it too.
--
-- The floor is warmup's minimum gap: 20 minutes (1200s), matching
-- WARMUP_MIN_GAP_SECONDS in src/warmup/plan.ts (owner decision 2026-10-03:
-- warmup sends 20-25 min apart). The JS pacer still adds jitter up to
-- WARMUP_MAX_GAP_SECONDS on top; this only guarantees the minimum, so a
-- failed reservation just defers that warmup to a later tick (send.ts already
-- handles a false reservation as "try later").

create or replace function public.mailbox_reserve_warmup(mailbox uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  update public.mailboxes
     set sent_today = case when sent_today_date < current_date then 1 else sent_today + 1 end,
         sent_today_date = current_date,
         last_warmup_at = now()
   where id = mailbox
     and is_active
     and (sent_today_date < current_date or sent_today < daily_limit)
     -- The rest-gap floor for warmup. Without this, concurrent warmup ticks
     -- each read a stale last_warmup_at and all reserved at once (bursts).
     and (
       last_warmup_at is null
       or last_warmup_at <= now() - make_interval(secs => 1200)
     );

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

grant execute on function public.mailbox_reserve_warmup(uuid) to authenticated, service_role;
