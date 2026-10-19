-- 0027_workspace_day_pkt.sql
--
-- The CRM's "day" is now the Pakistan calendar day (Asia/Karachi), not UTC.
-- The daily limit used to reset at UTC midnight — 5:00 AM Pakistan time — and
-- every report, counter and "today" figure moved with it. Everything now resets
-- at 12:00 AM Pakistan Standard Time.
--
-- One shared definition, used identically on both sides so the app and the
-- database can never disagree about when the day rolls over:
--   TypeScript:  workspaceDay()            (src/lib/datetime.ts)
--   SQL:         (now() at time zone 'Asia/Karachi')::date
--
-- DEPLOY ORDER (read before applying):
--   1. Deploy the app code first (it writes sent_today_date as the Pakistan
--      date). The functions below are written to stay correct while the old
--      app is still running: with old UTC-written dates they behave exactly as
--      before, and with new Pakistan-written dates they roll at 12 AM PKT.
--   2. Apply this SQL in the Supabase dashboard SQL editor, then confirm
--      "Success. No rows returned".
--   3. Do NOT apply this SQL while the old app code is still live AND the
--      Pakistan date differs from the UTC date (12:00–5:00 AM PKT): in that
--      window the new functions would see a "future" sent_today_date and keep
--      incrementing yesterday's counter instead of rolling it. After 5 AM PKT
--      the two dates agree and the order stops mattering.

-- ---------------------------------------------------------------------
-- Daily counter: mailbox_reserve_send (current live version is 0019's,
-- which dropped the old 1-arg overload and added the rest-gap floor)
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
  update public.mailboxes
     set sent_today = case when sent_today_date < today then 1 else sent_today + 1 end,
         sent_today_date = today,
         last_send_at = now()
   where id = mailbox
     and is_active
     and (allow_paused or health_status <> 'paused')
     and (sent_today_date < today or sent_today < daily_limit)
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

-- ---------------------------------------------------------------------
-- Daily counter: mailbox_reserve_warmup (current live version is 0025's)
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
  update public.mailboxes
     set sent_today = case when sent_today_date < today then 1 else sent_today + 1 end,
         sent_today_date = today,
         last_warmup_at = now()
   where id = mailbox
     and is_active
     and (sent_today_date < today or sent_today < daily_limit)
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

-- ---------------------------------------------------------------------
-- Daily counter: mailbox_release_send (0002; releases a slot on send failure)
-- ---------------------------------------------------------------------
create or replace function public.mailbox_release_send(mailbox uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = greatest(sent_today - 1, 0)
   where id = mailbox
     and sent_today_date = (now() at time zone 'Asia/Karachi')::date;
$$;

-- ---------------------------------------------------------------------
-- Column defaults that mean "today" (fallbacks; the app writes explicitly)
-- ---------------------------------------------------------------------
alter table public.mailboxes
  alter column sent_today_date
  set default (now() at time zone 'Asia/Karachi')::date;

alter table public.mailbox_health
  alter column date
  set default (now() at time zone 'Asia/Karachi')::date;

-- ---------------------------------------------------------------------
-- Reports: warmup_activity (0013) — "today" buckets on the Pakistan day
-- ---------------------------------------------------------------------
create or replace function public.warmup_activity(p_workspace uuid)
returns table (
  mailbox_id uuid,
  sent_today bigint,
  received_today bigint,
  replied_today bigint,
  sent_7d bigint,
  received_7d bigint,
  replied_7d bigint,
  in_spam_7d bigint,
  rescued_7d bigint
)
language sql
security definer
set search_path = public
as $$
  with sent as (
    select
      from_mailbox_id as mb,
      count(*) filter (where (sent_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date) as sent_today,
      count(*) as sent_7d,
      count(*) filter (where is_reply) as replied_7d_all,
      count(*) filter (where is_reply and (sent_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date) as replied_today,
      count(*) filter (where landed_in_spam) as in_spam_7d,
      count(*) filter (where rescued) as rescued_7d
    from public.warmup_messages
    where workspace_id = p_workspace
      and sent_at >= now() - interval '7 days'
    group by 1
  ),
  received as (
    select
      to_mailbox_id as mb,
      count(*) filter (where (sent_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date) as received_today,
      count(*) as received_7d
    from public.warmup_messages
    where workspace_id = p_workspace
      and sent_at >= now() - interval '7 days'
    group by 1
  )
  select
    coalesce(s.mb, r.mb) as mailbox_id,
    coalesce(s.sent_today, 0),
    coalesce(r.received_today, 0),
    coalesce(s.replied_today, 0),
    coalesce(s.sent_7d, 0),
    coalesce(r.received_7d, 0),
    coalesce(s.replied_7d_all, 0),
    coalesce(s.in_spam_7d, 0),
    coalesce(s.rescued_7d, 0)
  from sent s
  full outer join received r on s.mb = r.mb
  where public.is_workspace_member(p_workspace);
$$;

grant execute on function public.warmup_activity(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Reports: report_series (0013) — per-day buckets on the Pakistan day
--
-- Days are bucketed on the Pakistan calendar date so they line up with the
-- daily send counter (`sent_today_date`) and with the chart's own day
-- boundaries.
-- ---------------------------------------------------------------------
create or replace function public.report_series(
  p_workspace uuid,
  p_since timestamptz
)
returns table (
  day date,
  sent bigint,
  replies bigint,
  bounces bigint,
  opens bigint,
  clicks bigint,
  opened_emails bigint,
  clicked_emails bigint,
  tracked bigint,
  click_tracked bigint
)
language sql
security definer
set search_path = public
as $$
  with outbound as (
    select
      ((sent_at at time zone 'Asia/Karachi')::date) as d,
      count(*) as sent,
      coalesce(sum((meta #>> '{tracking,open,count}')::int), 0) as opens,
      coalesce(sum((meta #>> '{tracking,click,count}')::int), 0) as clicks,
      count(*) filter (where (meta #>> '{tracking,open,count}')::int > 0) as opened_emails,
      count(*) filter (where (meta #>> '{tracking,click,count}')::int > 0) as clicked_emails,
      count(*) filter (where coalesce(meta #>> '{tracking,mode}', 'off') <> 'off') as tracked,
      count(*) filter (where (meta #>> '{tracking,mode}') = 'opens_and_clicks') as click_tracked
    from public.messages
    where workspace_id = p_workspace
      and direction = 'outbound'
      and status = 'sent'
      and sent_at is not null
      and sent_at >= p_since
    group by 1
  ),
  inbound as (
    select
      ((received_at at time zone 'Asia/Karachi')::date) as d,
      count(*) filter (where not is_bounce and not is_auto_reply) as replies,
      count(*) filter (where is_bounce) as bounces
    from public.messages
    where workspace_id = p_workspace
      and direction = 'inbound'
      and received_at is not null
      and received_at >= p_since
    group by 1
  )
  select
    coalesce(o.d, i.d) as day,
    coalesce(o.sent, 0) as sent,
    coalesce(i.replies, 0) as replies,
    coalesce(i.bounces, 0) as bounces,
    coalesce(o.opens, 0) as opens,
    coalesce(o.clicks, 0) as clicks,
    coalesce(o.opened_emails, 0) as opened_emails,
    coalesce(o.clicked_emails, 0) as clicked_emails,
    coalesce(o.tracked, 0) as tracked,
    coalesce(o.click_tracked, 0) as click_tracked
  from outbound o
  full outer join inbound i on o.d = i.d
  where public.is_workspace_member(p_workspace)
  order by day;
$$;

grant execute on function public.report_series(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- Reports: mailbox_volume (0013) — "today" on the Pakistan day
-- ---------------------------------------------------------------------
create or replace function public.mailbox_volume(p_workspace uuid)
returns table (
  mailbox_id uuid,
  today_outreach bigint,
  today_warmup bigint,
  d7_outreach bigint,
  d7_warmup bigint,
  d14_outreach bigint,
  d14_warmup bigint,
  d30_outreach bigint,
  d30_warmup bigint,
  d60_outreach bigint,
  d60_warmup bigint,
  d90_outreach bigint,
  d90_warmup bigint
)
language sql
security definer
set search_path = public
as $$
  with base as (
    select
      mailbox_id as mb,
      sent_at,
      ((meta ->> 'kind') = 'warmup') as is_warmup
    from public.messages
    where workspace_id = p_workspace
      and direction = 'outbound'
      and status = 'sent'
      and mailbox_id is not null
      and sent_at is not null
      and sent_at >= now() - interval '90 days'
  )
  select
    mb as mailbox_id,
    count(*) filter (where not is_warmup and (sent_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date),
    count(*) filter (where is_warmup and (sent_at at time zone 'Asia/Karachi')::date = (now() at time zone 'Asia/Karachi')::date),
    count(*) filter (where not is_warmup and sent_at >= now() - interval '7 days'),
    count(*) filter (where is_warmup and sent_at >= now() - interval '7 days'),
    count(*) filter (where not is_warmup and sent_at >= now() - interval '14 days'),
    count(*) filter (where is_warmup and sent_at >= now() - interval '14 days'),
    count(*) filter (where not is_warmup and sent_at >= now() - interval '30 days'),
    count(*) filter (where is_warmup and sent_at >= now() - interval '30 days'),
    count(*) filter (where not is_warmup and sent_at >= now() - interval '60 days'),
    count(*) filter (where is_warmup and sent_at >= now() - interval '60 days'),
    count(*) filter (where not is_warmup and sent_at >= now() - interval '90 days'),
    count(*) filter (where is_warmup and sent_at >= now() - interval '90 days')
  from base
  where public.is_workspace_member(p_workspace)
  group by mb;
$$;

grant execute on function public.mailbox_volume(uuid) to authenticated;
