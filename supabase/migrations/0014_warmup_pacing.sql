-- ---------------------------------------------------------------------
-- Warmup pacing (0014)
--
-- Warmup was throttled two ways that together made it "very less": a global cap
-- of five sends per tick shared across every mailbox, and — the bigger one —
-- it waited the full 2–4 hour outreach rest gap between warmup sends, because
-- it paced itself on the same `last_send_at` clock real outreach uses. That
-- capped each mailbox at roughly 6–12 warmup emails a day no matter how high
-- its target was.
--
-- The fix is to give warmup its own clock. `last_warmup_at` paces warmup
-- (short gap), `last_send_at` still paces outreach (human gap), and the two no
-- longer fight: firing warmup often no longer resets the outreach rest timer,
-- so aggressive warmup cannot starve real sending. The daily *cap* stays shared
-- — a mailbox set to 30/day still sends 30 in total, warmup included — which is
-- the rule the user set.
--
-- `last_engaged_at` lets the open/flag/rescue pass rotate through mailboxes
-- instead of always touching whichever row came back first, so every mailbox
-- gets its spam rescued, not just one.
-- ---------------------------------------------------------------------

alter table public.mailboxes
  add column if not exists last_warmup_at timestamptz,
  add column if not exists last_engaged_at timestamptz;

-- Reserves a daily-limit slot for a warmup send. Like mailbox_reserve_send, but
-- it pings last_warmup_at instead of last_send_at (so outreach pacing is left
-- alone) and it always allows a health-auto-paused mailbox through (warmup is
-- exactly how a paused mailbox recovers). A *manually* deactivated mailbox
-- (is_active = false) is still blocked.
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
     and (sent_today_date < current_date or sent_today < daily_limit);

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

grant execute on function public.mailbox_reserve_warmup(uuid) to authenticated, service_role;
