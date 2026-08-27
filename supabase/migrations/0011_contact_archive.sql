-- 0011_contact_archive.sql
--
-- Contact archive / soft-delete (spec §8). `archived_at` takes a contact out of
-- the working list without losing the record or its history — the opposite of
-- the existing hard DELETE, which is permanent and re-scrapable. Archiving also
-- ends any live sequence for that contact (done in the archive route), so an
-- archived address stops receiving mail.
--
-- Deploy-safe: readers probe for this column (src/lib/contact-archive.ts) and
-- only apply the archive filter when it exists, so the contacts list keeps
-- working in the window between deploying and applying this migration.

alter table public.contacts
  add column if not exists archived_at timestamptz;

comment on column public.contacts.archived_at is
  'Soft-delete (spec §8): set = hidden from the working list, record + history kept; null = active.';

-- Partial index: the working list filters `archived_at is null` on every load,
-- and the archived view wants the small set where it is set.
create index if not exists contacts_archived_idx
  on public.contacts (workspace_id, archived_at);
