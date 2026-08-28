-- ---------------------------------------------------------------------
-- Report aggregates (0013)
--
-- Why this exists: the Reports page used to count rows in JavaScript
-- (`sentRows.length`), and PostgREST caps every row-returning query at the
-- project's `max-rows` setting — 1000 by default. So once a workspace had sent
-- more than 1000 emails in the window, every headline figure froze at 1000 and
-- the volume chart under-counted with it.
--
-- Counting belongs in the database. These functions aggregate server-side and
-- return at most a few hundred rows (one per day, or one per mailbox), so they
-- are never touched by the row cap. The result is genuinely unlimited: the
-- numbers are correct whether a mailbox has sent 900 emails or 900,000.
--
-- Both are SECURITY DEFINER so they can read across the workspace's rows, and
-- both gate on is_workspace_member(p_workspace) so a caller can only ever
-- aggregate a workspace they belong to. The app calls them with the signed-in
-- user's client, never the service role.
-- ---------------------------------------------------------------------

-- Per-UTC-day totals for the whole Reports page: sends, replies, bounces, and
-- the open/click engagement that used to be summed from `meta` in JS.
--
-- Days are bucketed on the UTC calendar date so they line up with the daily
-- send counter (`sent_today_date`) and with the chart's own day boundaries.
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
      ((sent_at at time zone 'UTC')::date) as d,
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
      ((received_at at time zone 'UTC')::date) as d,
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

-- Per-mailbox sent volume over the windows the mailbox table shows, split into
-- real outreach vs warmup (warmup carries meta.kind = 'warmup'). One row per
-- mailbox, so it too is immune to the row cap.
--
-- `today` is the UTC calendar date; the day windows are rolling (last N × 24h),
-- matching mailboxes/volume.ts so the numbers agree wherever they are shown.
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
    count(*) filter (where not is_warmup and (sent_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date),
    count(*) filter (where is_warmup and (sent_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date),
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

-- Per-mailbox warmup activity: how many warmup emails a mailbox has sent,
-- received, replied to, had land in spam, and had rescued back to the inbox,
-- today and over the last 7 days. This is the "how many emails back and forth"
-- view the Deliverability page shows so warmup stops being a black box.
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
      count(*) filter (where (sent_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as sent_today,
      count(*) as sent_7d,
      count(*) filter (where is_reply) as replied_7d_all,
      count(*) filter (where is_reply and (sent_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as replied_today,
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
      count(*) filter (where (sent_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as received_today,
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

grant execute on function public.report_series(uuid, timestamptz) to authenticated;
grant execute on function public.mailbox_volume(uuid) to authenticated;
grant execute on function public.warmup_activity(uuid) to authenticated;
