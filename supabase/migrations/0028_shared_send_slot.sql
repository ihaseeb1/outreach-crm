-- 0028_shared_send_slot.sql
--
-- One shared send slot per mailbox (owner decision 2026-10-21):
--   * 15 outreach + 5 warmup = 20 emails per mailbox per day, in total.
--   * Minimum 1 hour between ANY two sends from a mailbox — warmup and
--     outreach share the same slot. If a warmup goes out in one hour, the
--     next hour belongs to outreach (or a later warmup), never to both.
--
-- Why a migration: warmup and outreach used to pace on SEPARATE clocks
-- (0014: mailbox_reserve_warmup stamps only last_warmup_at and its DB
-- floor was 20 minutes on that clock alone; mailbox_reserve_send checks
-- only last_send_at). Two sends of different kinds could therefore leave
-- the same mailbox minutes apart, and no UI setting could prevent it.
--
-- This migration:
--   1. Makes both reserve functions enforce the gap floor against the
--      LATER of last_send_at / last_warmup_at, with a hard 1-hour floor
--      (greatest(min_gap_seconds, 3600)), and stamp BOTH clocks on every
--      reserved send — one shared clock at the database level, matching
--      the engines' JS checks.
--   2. Makes mailbox_reserve_send also enforce the day's outreach split:
--      outreach sends today must stay below daily_limit minus the
--      mailbox's warmup goal, so outreach can never eat the warmup slots
--      (and the shared total cap already keeps warmup + outreach <= 20).
--   3. Applies the owner's new per-mailbox settings: daily_limit 20,
--      gaps 60-65 minutes, warmup goal 5/day (current = target = 5, so
--      the ramp holds it there instead of climbing past it).
--
-- It does NOT unpause anything: mailboxes stay is_active = false and
-- campaigns stay paused until the owner-ordered unpause step runs in the
-- CRM UI after this SQL is applied. The 2 draft campaigns are untouched.
--
-- Day definition is unchanged: the Pakistan day (0027).

-- ---------------------------------------------------------------------
-- 1+2. mailbox_reserve_send — shared gap floor, stamps both clocks,
--      outreach split guard
-- ---------------------------------------------------------------------
create or replace function public.mailbox_reserve_send(
  mailbox uuid,
  allow_paused boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
  today date := (now() at time zone 'Asia/Karachi')::date;
begin
  update public.mailboxes m
     set sent_today = case when m.sent_today_date < today then 1 else m.sent_today + 1 end,
         sent_today_date = today,
         last_send_at = now(),
         last_warmup_at = now()
   where m.id = mailbox
     and m.is_active
     and (allow_paused or m.health_status <> 'paused')
     and (m.sent_today_date < today or m.sent_today < m.daily_limit)
     -- The shared rest-gap floor: at least the mailbox's min gap, and
     -- never less than 1 hour, since the LATER of the two send clocks —
     -- a warmup send rests outreach exactly as an outreach send does.
     and (
       greatest(
         coalesce(m.last_send_at, 'epoch'::timestamptz),
         coalesce(m.last_warmup_at, 'epoch'::timestamptz)
       ) <= now() - make_interval(secs => greatest(coalesce(m.min_gap_seconds, 0), 3600))
     )
     -- The outreach split: today's outreach sends (messages that are not
     -- warmup) must stay under daily_limit minus the warmup goal, so the
     -- warmup slots are still there when the warmup engine runs. With no
     -- enabled warmup settings row there is nothing to reserve.
     and (
       select count(*)
         from public.messages msg
        where msg.mailbox_id = m.id
          and msg.direction = 'outbound'
          and msg.status = 'sent'
          and (msg.sent_at at time zone 'Asia/Karachi')::date = today
          and not coalesce(msg.is_warmup, false)
          and coalesce(msg.meta ->> 'kind', '') <> 'warmup'
     ) < (
       m.daily_limit - coalesce((
         select ws.target_daily_volume
           from public.warmup_settings ws
          where ws.mailbox_id = m.id
            and ws.enabled
       ), 0)
     );

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

grant execute on function public.mailbox_reserve_send(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. mailbox_reserve_warmup — shared gap floor (was: 20 min, warmup
--    clock only), stamps both clocks. Still allowed from a
--    health-auto-paused mailbox (warmup is how it recovers); a manually
--    paused mailbox (is_active = false) still stops everything.
-- ---------------------------------------------------------------------
create or replace function public.mailbox_reserve_warmup(mailbox uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
  today date := (now() at time zone 'Asia/Karachi')::date;
begin
  update public.mailboxes m
     set sent_today = case when m.sent_today_date < today then 1 else m.sent_today + 1 end,
         sent_today_date = today,
         last_warmup_at = now(),
         last_send_at = now()
   where m.id = mailbox
     and m.is_active
     and (m.sent_today_date < today or m.sent_today < m.daily_limit)
     -- The shared rest-gap floor (see mailbox_reserve_send above): at
     -- least 1 hour since the last send of ANY kind from this mailbox.
     and (
       greatest(
         coalesce(m.last_send_at, 'epoch'::timestamptz),
         coalesce(m.last_warmup_at, 'epoch'::timestamptz)
       ) <= now() - make_interval(secs => greatest(coalesce(m.min_gap_seconds, 0), 3600))
     );

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

grant execute on function public.mailbox_reserve_warmup(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. The owner's new per-mailbox settings (2026-10-21)
--    20/day total, 60-65 minute gaps, warmup 5/day flat.
-- ---------------------------------------------------------------------
update public.mailboxes
   set daily_limit = 20,
       min_gap_seconds = 3600,
       max_gap_seconds = 3900;

update public.warmup_settings
   set current_daily_volume = 5,
       target_daily_volume = 5
 where enabled;
