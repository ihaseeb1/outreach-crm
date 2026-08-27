-- 0009_roles_approval.sql
--
-- Multi-user access control (spec §5): a signup-approval gate and app-level
-- roles, enforced in the database rather than by hiding UI.
--
-- The gate hangs off one central function: is_workspace_member() — already the
-- guard on every workspace-scoped table — now also requires the caller's
-- profile to be `active`. A pending/rejected/banned account therefore reads no
-- workspace data anywhere, with no per-table policy changes.
--
-- Safe to apply to the live single-user database: existing accounts are
-- grandfathered to `active` before any pending signup can exist, and the
-- founding account is promoted to super_admin, so the owner is never locked out.
-- The service role (all cron/background work) bypasses RLS, so sending is
-- unaffected.

-- 1. Account-level status + role on the profile.
alter table public.profiles
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'active', 'rejected', 'banned')),
  add column if not exists app_role text not null default 'member'
    check (app_role in ('super_admin', 'admin', 'member')),
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users (id) on delete set null;

create index if not exists profiles_status_idx on public.profiles (status);

-- 2. Grandfather every existing account in (they predate the gate) and make the
--    founding account — the earliest profile — the super admin.
update public.profiles set status = 'active' where status = 'pending';
update public.profiles
   set app_role = 'super_admin'
 where id = (select id from public.profiles order by created_at asc limit 1)
   and app_role <> 'super_admin';

-- 3. Is the caller an active app admin? Used by the approvals API and to decide
--    whether the Approvals nav link shows.
create or replace function public.is_app_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and status = 'active'
      and app_role in ('super_admin', 'admin')
  );
$$;

-- 3b. Close the self-approval hole. The "profiles: self update" policy lets a
--     user edit their own row — which, with table-level UPDATE, would let a
--     pending user set their own status='active' or app_role='super_admin' and
--     walk straight through the gate. Column-level UPDATE fixes it: the
--     authenticated role may change only its display name; status/role/approval
--     columns are writable only by the service role (the approvals API), which
--     bypasses RLS. Nothing in the app updates a profile through the user client
--     today, so granting just full_name back loses no functionality.
revoke update on public.profiles from authenticated;
revoke update on public.profiles from anon;
grant update (full_name) on public.profiles to authenticated;

-- 4. The gate: a workspace member must also be an *active* account. This is the
--    same function every workspace-table policy already calls, so the check
--    lands everywhere at once.
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.profiles p on p.id = m.user_id
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and p.status = 'active'
  );
$$;
