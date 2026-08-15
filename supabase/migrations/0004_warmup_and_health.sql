-- =====================================================================
-- 0004 — Peer warmup and mailbox health.
--
-- Warmup is a closed loop between the workspace's own mailboxes: they email
-- each other, open, flag, rescue from spam, and reply. There is no paid pool.
--
-- Warmup traffic lives here and NEVER in `messages`, so the unified inbox only
-- ever contains real correspondence.
-- =====================================================================

create table public.warmup_settings (
  id                    uuid primary key default gen_random_uuid(),
  mailbox_id            uuid not null unique references public.mailboxes (id) on delete cascade,
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  enabled               boolean not null default false,
  -- Start small and human. Google and Microsoft actively detect artificial
  -- warmup, so the ramp is deliberately slow.
  current_daily_volume  integer not null default 5  check (current_daily_volume >= 0),
  target_daily_volume   integer not null default 40 check (target_daily_volume >= 0),
  ramp_increment        integer not null default 2  check (ramp_increment >= 0),
  -- Fraction of received warmup mail that gets a reply, 0–1.
  reply_rate            numeric(3, 2) not null default 0.35
                          check (reply_rate >= 0 and reply_rate <= 1),
  last_ramped_on        date,
  started_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index warmup_settings_workspace_idx on public.warmup_settings (workspace_id, enabled);

create table public.warmup_messages (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  from_mailbox_id  uuid not null references public.mailboxes (id) on delete cascade,
  to_mailbox_id    uuid not null references public.mailboxes (id) on delete cascade,
  subject          text,
  message_id       text,
  -- HMAC carried in the X-OCRM-Warmup header; how inbound mail is recognised
  -- as warmup rather than a real reply.
  token            text not null,
  is_reply         boolean not null default false,
  in_reply_to      text,
  opened           boolean not null default false,
  replied          boolean not null default false,
  landed_in_spam   boolean not null default false,
  rescued          boolean not null default false,
  delivered_at     timestamptz,
  replied_at       timestamptz,
  sent_at          timestamptz not null default now()
);

create index warmup_messages_from_idx on public.warmup_messages (from_mailbox_id, sent_at desc);
create index warmup_messages_to_idx on public.warmup_messages (to_mailbox_id, sent_at desc);
create index warmup_messages_token_idx on public.warmup_messages (token);
create index warmup_messages_pending_reply_idx
  on public.warmup_messages (to_mailbox_id)
  where opened and not replied and not is_reply;
create unique index warmup_messages_message_id_idx
  on public.warmup_messages (workspace_id, message_id)
  where message_id is not null;

create table public.mailbox_health (
  id               uuid primary key default gen_random_uuid(),
  mailbox_id       uuid not null references public.mailboxes (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  date             date not null default current_date,
  reputation_score integer not null default 100 check (reputation_score between 0 and 100),
  sent_7d          integer not null default 0,
  bounce_rate      numeric(5, 4) not null default 0,
  complaint_rate   numeric(5, 4) not null default 0,
  reply_rate       numeric(5, 4) not null default 0,
  -- Warmup landing in spam is the earliest warning signal available for free.
  warmup_spam_rate numeric(5, 4) not null default 0,
  spf_ok           boolean,
  dkim_ok          boolean,
  dmarc_ok         boolean,
  dns_detail       jsonb not null default '{}'::jsonb,
  blacklists       jsonb not null default '[]'::jsonb,
  status           text not null default 'healthy'
                     check (status in ('healthy', 'warning', 'paused')),
  issues           jsonb not null default '[]'::jsonb,
  checked_at       timestamptz not null default now(),
  unique (mailbox_id, date)
);

create index mailbox_health_mailbox_idx on public.mailbox_health (mailbox_id, date desc);

-- Cache for DNS-based checks. Several public DNSBLs rate-limit aggressively,
-- so a domain is looked up at most once a day across all mailboxes.
create table public.dns_check_cache (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,
  result     jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index dns_check_cache_expiry_idx on public.dns_check_cache (expires_at);

create trigger warmup_settings_set_updated_at
  before update on public.warmup_settings
  for each row execute function public.set_updated_at();

alter table public.warmup_settings enable row level security;
alter table public.warmup_messages enable row level security;
alter table public.mailbox_health  enable row level security;
alter table public.dns_check_cache enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['warmup_settings', 'warmup_messages', 'mailbox_health']
  loop
    execute format(
      'create policy %I on public.%I for select using (public.is_workspace_member(workspace_id));',
      t || ': member select', t);
    execute format(
      'create policy %I on public.%I for insert with check (public.is_workspace_member(workspace_id));',
      t || ': member insert', t);
    execute format(
      'create policy %I on public.%I for update using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));',
      t || ': member update', t);
    execute format(
      'create policy %I on public.%I for delete using (public.is_workspace_member(workspace_id));',
      t || ': member delete', t);
  end loop;
end;
$$;

-- The DNS cache holds no workspace data; only background jobs (service role)
-- touch it, and RLS with no policy denies everyone else by default.
