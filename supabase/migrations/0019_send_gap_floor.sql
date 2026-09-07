-- 0019_send_gap_floor.sql
--
-- Enforce the per-mailbox inter-send gap ATOMICALLY, inside the reservation.
--
-- The bug: a mailbox was firing 3–4 emails back to back. Rotation already
-- carried a rest gap (min_gap_seconds..max_gap_seconds), but it was checked only
-- in JavaScript (campaigns/rotation.ts -> mailboxIsRested), reading the
-- last_send_at that was loaded once at the start of a batch. The atomic DB
-- reservation (mailbox_reserve_send) enforced only the daily limit, never the
-- gap. So any two senders running at the same instant — the campaigns and
-- warmup cron jobs fire in PARALLEL every tick, plus a manual "send now" or a
-- delayed/overlapping tick — each read the same stale last_send_at, each passed
-- the JS check, each reserved, and each sent. That is the burst.
--
-- The fix: make the gap a hard floor in the same UPDATE that reserves the slot.
-- Two sends from one mailbox can now never land inside its own gap, whatever
-- fires them, because only one UPDATE can win the row for that window. The
-- loser's reservation returns false; the caller leaves that contact due and it
-- goes out on a later tick — no step skipped (exactly the "one at a time per
-- account, the other sent later" behaviour requested).
--
-- Why gate on `NOT allow_paused` instead of a new parameter: outreach reserves
-- with allow_paused = false (the default); the ONLY caller that passes
-- allow_paused = true is warmup's fallback path in mail/send.ts, used when
-- migration 0014 (warmup's own last_warmup_at clock) is not yet applied. Warmup
-- must NOT be throttled by the outreach gap — that is the whole point of 0014 —
-- so allow_paused doubles as "this is a warmup reservation, skip the gap". This
-- keeps the fix to a single migration with no application change, so a deploy
-- can land before or after this SQL either way.
--
-- The floor is the mailbox's own min_gap_seconds (default 90). JavaScript still
-- adds jitter up to max_gap_seconds on top; this only guarantees the minimum.

drop function if exists public.mailbox_reserve_send(uuid, boolean);
drop function if exists public.mailbox_reserve_send(uuid);

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
begin
  update public.mailboxes
     set sent_today = case when sent_today_date < current_date then 1 else sent_today + 1 end,
         sent_today_date = current_date,
         last_send_at = now()
   where id = mailbox
     and is_active
     and (allow_paused or health_status <> 'paused')
     and (sent_today_date < current_date or sent_today < daily_limit)
     -- The rest-gap floor. Skipped for warmup (allow_paused), which paces itself
     -- on last_warmup_at via mailbox_reserve_warmup (0014).
     and (
       allow_paused
       or last_send_at is null
       or last_send_at <= now() - make_interval(secs => greatest(coalesce(min_gap_seconds, 0), 0))
     );

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

grant execute on function public.mailbox_reserve_send(uuid, boolean) to authenticated, service_role;
