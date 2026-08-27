-- =====================================================================
-- 0007 — Per-thread conversations, richer verification statuses, and
--        warmup-while-auto-paused.
--
-- Apply by hand in the Supabase SQL editor (same as every migration here).
-- Safe to run once; the guards make a second run a no-op.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. Conversations split by thread, not by contact.
--
-- Until now a conversation was keyed on (workspace_id, contact_id): at most one
-- thread per contact, ever. So two separate pitches to the SAME address about
-- two DIFFERENT websites collapsed into one thread in the inbox. Each pitch is
-- its own email thread (its own root Message-ID, carried on every reply via
-- In-Reply-To), so keying on the thread instead separates the two pitches while
-- still keeping one back-and-forth exchange together. Mail with no thread id
-- falls back to the old per-contact grouping.
-- ---------------------------------------------------------------------

alter table public.messages
  add column if not exists thread_key text;

alter table public.conversations
  add column if not exists thread_key text;

-- Derive the key for every already-stored message.
update public.messages
   set thread_key = coalesce(thread_id, 'contact:' || contact_id::text)
 where contact_id is not null
   and not is_bounce
   and not is_auto_reply
   and thread_key is null;

-- Rebuild conversations from the thread key. Conversation rows are derived data
-- (the trigger recreates them), so clearing and rebuilding is safe and gives the
-- correct split immediately. deals.conversation_id is ON DELETE SET NULL and is
-- re-linked by contact anyway, so nothing of substance is lost.
update public.deals set conversation_id = null;
delete from public.conversations;

-- Drop the old one-conversation-per-contact unique, whatever it is named. The
-- inline `unique (workspace_id, contact_id)` gets the standard auto name, but
-- look it up by definition so a differently-named constraint is still removed —
-- if it survived, the rebuild below (many thread_keys per contact) would violate
-- it.
do $$
declare
  cons_name text;
begin
  select con.conname into cons_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'conversations'
     and con.contype = 'u'
     and pg_get_constraintdef(con.oid) = 'UNIQUE (workspace_id, contact_id)';
  if cons_name is not null then
    execute format('alter table public.conversations drop constraint %I', cons_name);
  end if;
end $$;

create unique index if not exists conversations_workspace_thread_key
  on public.conversations (workspace_id, thread_key);

create index if not exists messages_thread_key_idx
  on public.messages (workspace_id, thread_key);

create or replace function public.messages_attach_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_id  uuid;
  conv_key text;
begin
  if new.contact_id is null or new.is_bounce or new.is_auto_reply then
    return new;
  end if;

  -- The pitch's own thread separates two campaigns to the same address; mail
  -- with no thread id keeps the old per-contact behaviour.
  conv_key := coalesce(new.thread_id, 'contact:' || new.contact_id::text);
  new.thread_key := conv_key;

  select id into conv_id
    from public.conversations
   where workspace_id = new.workspace_id
     and thread_key = conv_key;

  if conv_id is null then
    insert into public.conversations (
      workspace_id, contact_id, thread_key, mailbox_id, subject,
      last_message_at, last_direction, is_read
    )
    values (
      new.workspace_id, new.contact_id, conv_key, new.mailbox_id, new.subject,
      coalesce(new.received_at, new.sent_at, now()),
      new.direction,
      new.direction = 'outbound'
    )
    on conflict (workspace_id, thread_key) do update
      set last_message_at = excluded.last_message_at
    returning id into conv_id;
  else
    update public.conversations
       set last_message_at = coalesce(new.received_at, new.sent_at, now()),
           last_direction  = new.direction,
           is_read = case when new.direction = 'inbound' then false else is_read end,
           mailbox_id = coalesce(new.mailbox_id, mailbox_id),
           status = case when new.direction = 'inbound' then 'open' else status end
     where id = conv_id;
  end if;

  new.conversation_id = conv_id;
  return new;
end;
$$;

-- Recreate conversations for existing messages, one per (workspace, thread_key).
insert into public.conversations (
  workspace_id, contact_id, thread_key, mailbox_id, subject,
  last_message_at, last_direction, is_read
)
select distinct on (m.workspace_id, m.thread_key)
  m.workspace_id,
  m.contact_id,
  m.thread_key,
  m.mailbox_id,
  m.subject,
  coalesce(m.received_at, m.sent_at, m.created_at),
  m.direction,
  m.direction = 'outbound'
from public.messages m
where m.contact_id is not null
  and m.thread_key is not null
  and not m.is_bounce
  and not m.is_auto_reply
order by m.workspace_id, m.thread_key, coalesce(m.received_at, m.sent_at, m.created_at) desc
on conflict (workspace_id, thread_key) do nothing;

update public.messages m
   set conversation_id = c.id
  from public.conversations c
 where c.workspace_id = m.workspace_id
   and c.thread_key = m.thread_key
   and m.thread_key is not null
   and not m.is_bounce
   and not m.is_auto_reply;

-- ---------------------------------------------------------------------
-- B. Richer verification statuses.
--
-- The in-house verifier now returns the full Reoon-style taxonomy. Widen the
-- allowed set so those verdicts can be stored.
-- ---------------------------------------------------------------------

alter table public.contacts
  drop constraint if exists contacts_validation_status_check;

alter table public.contacts
  add constraint contacts_validation_status_check
  check (validation_status in (
    'unknown', 'valid', 'safe', 'catch_all', 'invalid', 'invalid_syntax',
    'no_mx', 'disposable', 'spamtrap', 'disabled', 'inbox_full',
    'role_account', 'suppressed', 'bounced'
  ));

-- ---------------------------------------------------------------------
-- C. Let a health-auto-paused mailbox keep warming up.
--
-- An auto-paused mailbox should stop OUTREACH but keep WARMUP running so its
-- reputation can recover — "drops to warmup until healthy again". Campaign and
-- compose sends still pass allow_paused = false (the default) and stay blocked;
-- the warmup engine passes true so peer mail can still go out.
-- ---------------------------------------------------------------------

-- Drop the old single-argument signature so the new default-param version is
-- the only overload (avoids PostgREST ambiguity on a one-arg call).
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
     and (sent_today_date < current_date or sent_today < daily_limit);

  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;
