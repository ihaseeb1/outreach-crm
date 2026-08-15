-- =====================================================================
-- 0002 — Mailboxes, campaigns, and the message log.
--
-- Phase 2 uses mailboxes + messages (single sends and inbound replies).
-- Phase 3 drives campaigns / sequence_steps / campaign_contacts, but the
-- tables land here so the phase 2 reply handler can already pause a sequence
-- the moment a contact replies.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Mailboxes
-- ---------------------------------------------------------------------

create table public.mailboxes (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces (id) on delete cascade,
  provider               text not null default 'smtp'
                           check (provider in ('smtp', 'gmail', 'outlook')),
  auth_type              text not null default 'app_password'
                           check (auth_type in ('app_password', 'oauth2')),
  email                  citext not null,
  from_name              text,
  -- AES-256-GCM ciphertext produced by src/lib/crypto.ts. Never selected into
  -- the browser; only server code decrypts it.
  encrypted_credentials  text,
  -- Gmail free 500/day, Workspace 2000/day; warmup counts against this too.
  daily_limit            integer not null default 50 check (daily_limit >= 0),
  sent_today             integer not null default 0,
  sent_today_date        date not null default current_date,
  -- Randomised gap between sends so traffic never looks like a blast.
  min_gap_seconds        integer not null default 90,
  max_gap_seconds        integer not null default 300,
  is_active              boolean not null default true,
  -- Set by the phase 4 health job; blocks campaign AND warmup sends.
  health_status          text not null default 'healthy'
                           check (health_status in ('healthy', 'warning', 'paused')),
  paused_reason          text,
  signature              text,
  imap_last_uid          bigint,
  last_polled_at         timestamptz,
  last_send_at           timestamptz,
  last_error             text,
  meta                   jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (workspace_id, email)
);

create index mailboxes_workspace_idx on public.mailboxes (workspace_id);
create index mailboxes_active_idx on public.mailboxes (is_active, health_status);

-- ---------------------------------------------------------------------
-- Campaigns and sequences
-- ---------------------------------------------------------------------

create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null,
  status        text not null default 'draft'
                  check (status in ('draft', 'active', 'paused', 'completed', 'archived')),
  mailbox_ids   jsonb not null default '[]'::jsonb,
  settings      jsonb not null default '{}'::jsonb,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index campaigns_workspace_idx on public.campaigns (workspace_id, created_at desc);

create table public.sequence_steps (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.campaigns (id) on delete cascade,
  step_number       integer not null check (step_number >= 1),
  -- Days to wait after the previous step. Step 1 is normally 0.
  delay_days        integer not null default 3 check (delay_days >= 0),
  subject_template  text not null default '',
  body_template     text not null default '',
  -- Follow-ups usually thread under the first email instead of restating it.
  reply_to_thread   boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (campaign_id, step_number)
);

create table public.campaign_contacts (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.campaigns (id) on delete cascade,
  contact_id    uuid not null references public.contacts (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  current_step  integer not null default 0,
  status        text not null default 'pending'
                  check (status in (
                    'pending', 'active', 'replied', 'completed',
                    'paused', 'bounced', 'unsubscribed', 'failed'
                  )),
  next_send_at  timestamptz,
  -- Sticks to one mailbox per contact so a thread stays coherent.
  mailbox_id    uuid references public.mailboxes (id) on delete set null,
  thread_id     text,
  last_sent_at  timestamptz,
  replied_at    timestamptz,
  paused_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (campaign_id, contact_id)
);

create index campaign_contacts_due_idx
  on public.campaign_contacts (status, next_send_at)
  where status in ('pending', 'active');
create index campaign_contacts_contact_idx on public.campaign_contacts (contact_id);
create index campaign_contacts_workspace_idx on public.campaign_contacts (workspace_id);

-- ---------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------

create table public.messages (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid references public.campaigns (id) on delete set null,
  contact_id    uuid references public.contacts (id) on delete set null,
  mailbox_id    uuid references public.mailboxes (id) on delete set null,
  direction     text not null check (direction in ('outbound', 'inbound')),
  step_number   integer,
  from_email    citext,
  to_email      citext,
  subject       text,
  body          text,
  body_html     text,
  -- RFC 5322 Message-ID, used to thread replies back to the original send.
  message_id    text,
  in_reply_to   text,
  thread_id     text,
  status        text not null default 'sent'
                  check (status in ('queued', 'sent', 'failed', 'received', 'bounced')),
  is_bounce     boolean not null default false,
  is_auto_reply boolean not null default false,
  error         text,
  meta          jsonb not null default '{}'::jsonb,
  sent_at       timestamptz,
  received_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index messages_workspace_idx on public.messages (workspace_id, created_at desc);
create index messages_contact_idx on public.messages (contact_id, created_at desc);
create index messages_thread_idx on public.messages (workspace_id, thread_id);
create index messages_mailbox_idx on public.messages (mailbox_id, created_at desc);
-- Idempotency for the IMAP poller: the same inbound mail is never stored twice.
create unique index messages_inbound_unique_idx
  on public.messages (workspace_id, message_id)
  where direction = 'inbound' and message_id is not null;

-- ---------------------------------------------------------------------
-- Daily counter reset
-- ---------------------------------------------------------------------

-- Rolls sent_today over at midnight without needing a scheduled job.
create or replace function public.mailbox_reserve_send(mailbox uuid)
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
     and health_status <> 'paused'
     and (sent_today_date < current_date or sent_today < daily_limit);

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;

create or replace function public.mailbox_release_send(mailbox uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = greatest(sent_today - 1, 0)
   where id = mailbox
     and sent_today_date = current_date;
$$;

-- ---------------------------------------------------------------------
-- Triggers, RLS
-- ---------------------------------------------------------------------

create trigger mailboxes_set_updated_at         before update on public.mailboxes         for each row execute function public.set_updated_at();
create trigger campaigns_set_updated_at         before update on public.campaigns         for each row execute function public.set_updated_at();
create trigger sequence_steps_set_updated_at    before update on public.sequence_steps    for each row execute function public.set_updated_at();
create trigger campaign_contacts_set_updated_at before update on public.campaign_contacts for each row execute function public.set_updated_at();

alter table public.mailboxes         enable row level security;
alter table public.campaigns         enable row level security;
alter table public.sequence_steps    enable row level security;
alter table public.campaign_contacts enable row level security;
alter table public.messages          enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['mailboxes', 'campaigns', 'campaign_contacts', 'messages']
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

-- sequence_steps has no workspace_id — it inherits access from its campaign.
create policy "sequence_steps: member select" on public.sequence_steps for select
  using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and public.is_workspace_member(c.workspace_id)
  ));
create policy "sequence_steps: member insert" on public.sequence_steps for insert
  with check (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and public.is_workspace_member(c.workspace_id)
  ));
create policy "sequence_steps: member update" on public.sequence_steps for update
  using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and public.is_workspace_member(c.workspace_id)
  ));
create policy "sequence_steps: member delete" on public.sequence_steps for delete
  using (exists (
    select 1 from public.campaigns c
    where c.id = campaign_id and public.is_workspace_member(c.workspace_id)
  ));

-- Credentials must never reach the browser, even for a workspace member.
revoke select on public.mailboxes from anon, authenticated;
grant select (
  id, workspace_id, provider, auth_type, email, from_name, daily_limit,
  sent_today, sent_today_date, min_gap_seconds, max_gap_seconds, is_active,
  health_status, paused_reason, signature, imap_last_uid, last_polled_at,
  last_send_at, last_error, meta, created_at, updated_at
) on public.mailboxes to authenticated;
