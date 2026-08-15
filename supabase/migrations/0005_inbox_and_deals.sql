-- =====================================================================
-- 0005 — Unified inbox and publisher deals.
--
-- Conversations are created by a trigger rather than by application code, so
-- every send path lands in the inbox consistently — and, just as importantly,
-- bounces, autoresponders and warmup traffic never do.
-- =====================================================================

create table public.conversations (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  contact_id       uuid not null references public.contacts (id) on delete cascade,
  mailbox_id       uuid references public.mailboxes (id) on delete set null,
  subject          text,
  last_message_at  timestamptz not null default now(),
  last_direction   text check (last_direction in ('inbound', 'outbound')),
  is_read          boolean not null default true,
  assigned_to      uuid references auth.users (id) on delete set null,
  status           text not null default 'open'
                     check (status in ('open', 'snoozed', 'closed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, contact_id)
);

create index conversations_workspace_idx
  on public.conversations (workspace_id, last_message_at desc);
create index conversations_unread_idx
  on public.conversations (workspace_id, is_read)
  where is_read = false;

alter table public.messages
  add column conversation_id uuid references public.conversations (id) on delete set null;

create index messages_conversation_idx
  on public.messages (conversation_id, created_at);

/**
 * Attaches a message to its conversation, creating one on first contact.
 *
 * Deliberately skipped for bounces and autoresponders: they are recorded for the
 * audit trail but must never surface as correspondence. Warmup mail never
 * reaches this table at all.
 */
create or replace function public.messages_attach_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_id uuid;
begin
  if new.contact_id is null or new.is_bounce or new.is_auto_reply then
    return new;
  end if;

  select id into conv_id
    from public.conversations
   where workspace_id = new.workspace_id
     and contact_id = new.contact_id;

  if conv_id is null then
    insert into public.conversations (
      workspace_id, contact_id, mailbox_id, subject,
      last_message_at, last_direction, is_read
    )
    values (
      new.workspace_id, new.contact_id, new.mailbox_id, new.subject,
      coalesce(new.received_at, new.sent_at, now()),
      new.direction,
      new.direction = 'outbound'
    )
    on conflict (workspace_id, contact_id) do update
      set last_message_at = excluded.last_message_at
    returning id into conv_id;
  else
    update public.conversations
       set last_message_at = coalesce(new.received_at, new.sent_at, now()),
           last_direction  = new.direction,
           -- An inbound message marks the thread unread; our own reply clears it.
           is_read = case when new.direction = 'inbound' then false else is_read end,
           mailbox_id = coalesce(new.mailbox_id, mailbox_id),
           status = case when new.direction = 'inbound' then 'open' else status end
     where id = conv_id;
  end if;

  new.conversation_id = conv_id;
  return new;
end;
$$;

create trigger messages_attach_conversation_trigger
  before insert on public.messages
  for each row execute function public.messages_attach_conversation();

-- ---------------------------------------------------------------------
-- Deals / rate cards
-- ---------------------------------------------------------------------

create table public.deals (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  contact_id      uuid references public.contacts (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  domain          text not null,
  link_type       text,          -- dofollow / nofollow / sponsored
  placement_type  text,          -- guest post / niche edit / homepage / press release
  tat_days        integer,       -- turnaround time
  da              integer,       -- Moz Domain Authority
  dr              integer,       -- Ahrefs Domain Rating
  monthly_traffic integer,
  spam_score      integer,
  word_count      integer,
  content_by      text,          -- us / publisher / either
  max_links       integer,
  payment_terms   text,          -- e.g. 50% upfront, net 30
  payment_method  text,          -- PayPal / Wise / bank transfer
  currency        text not null default 'USD',
  status          text not null default 'negotiating'
                    check (status in ('negotiating', 'agreed', 'ordered', 'live', 'rejected')),
  notes           text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index deals_workspace_idx on public.deals (workspace_id, updated_at desc);
create index deals_domain_idx on public.deals (workspace_id, domain);
create index deals_status_idx on public.deals (workspace_id, status);
create index deals_contact_idx on public.deals (contact_id);

-- One deal, many niche prices: General 150, Casino 400, CBD 350, …
create table public.deal_prices (
  id         uuid primary key default gen_random_uuid(),
  deal_id    uuid not null references public.deals (id) on delete cascade,
  niche      text not null,
  price      numeric(12, 2) not null check (price >= 0),
  currency   text not null default 'USD',
  created_at timestamptz not null default now(),
  unique (deal_id, niche)
);

create index deal_prices_deal_idx on public.deal_prices (deal_id);

create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();
create trigger deals_set_updated_at         before update on public.deals         for each row execute function public.set_updated_at();

alter table public.conversations enable row level security;
alter table public.deals         enable row level security;
alter table public.deal_prices   enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['conversations', 'deals']
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

-- deal_prices inherits access from its deal.
create policy "deal_prices: member select" on public.deal_prices for select
  using (exists (select 1 from public.deals d where d.id = deal_id and public.is_workspace_member(d.workspace_id)));
create policy "deal_prices: member insert" on public.deal_prices for insert
  with check (exists (select 1 from public.deals d where d.id = deal_id and public.is_workspace_member(d.workspace_id)));
create policy "deal_prices: member update" on public.deal_prices for update
  using (exists (select 1 from public.deals d where d.id = deal_id and public.is_workspace_member(d.workspace_id)));
create policy "deal_prices: member delete" on public.deal_prices for delete
  using (exists (select 1 from public.deals d where d.id = deal_id and public.is_workspace_member(d.workspace_id)));

-- Backfill conversations for messages that already exist.
insert into public.conversations (
  workspace_id, contact_id, mailbox_id, subject, last_message_at, last_direction, is_read
)
select distinct on (m.workspace_id, m.contact_id)
  m.workspace_id,
  m.contact_id,
  m.mailbox_id,
  m.subject,
  coalesce(m.received_at, m.sent_at, m.created_at),
  m.direction,
  m.direction = 'outbound'
from public.messages m
where m.contact_id is not null
  and not m.is_bounce
  and not m.is_auto_reply
order by m.workspace_id, m.contact_id, coalesce(m.received_at, m.sent_at, m.created_at) desc
on conflict (workspace_id, contact_id) do nothing;

update public.messages m
   set conversation_id = c.id
  from public.conversations c
 where c.workspace_id = m.workspace_id
   and c.contact_id = m.contact_id
   and m.conversation_id is null
   and not m.is_bounce
   and not m.is_auto_reply;
