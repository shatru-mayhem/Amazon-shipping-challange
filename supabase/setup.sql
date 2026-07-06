-- ASCS auth setup: head account, employee roster, auto profile creation.
-- Run this in Supabase Dashboard -> SQL Editor. Idempotent.
--
-- BEFORE running: create the head user in Dashboard -> Authentication ->
-- Users -> "Add user": email singhshatrughna.singh22@gmail.com,
-- password 654321, check "Auto Confirm User".

-- 1. Employee roster: the head account pre-registers employee emails here.
--    When that email later signs in, the trigger below assigns Employee role.
create table if not exists public.employee_roster (
  email text primary key,
  hierarchy_level text not null default 'Associate'
    check (hierarchy_level in ('Executive','Manager','Associate')),
  team text,
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.employee_roster enable row level security;

drop policy if exists "admins manage roster" on public.employee_roster;
create policy "admins manage roster" on public.employee_roster
  for all using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'Admin')
  );

-- 2. Auto-create a public.users profile on every new auth signup.
--    Role: Admin for the head email, Employee if on the roster, else Client.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  roster record;
begin
  select * into roster from public.employee_roster where email = new.email;
  insert into public.users (id, email, role, hierarchy_level, team)
  values (
    new.id,
    new.email,
    case
      when new.email = 'singhshatrughna.singh22@gmail.com' then 'Admin'
      when roster.email is not null then 'Employee'
      else 'Client'
    end,
    case
      when new.email = 'singhshatrughna.singh22@gmail.com' then 'Executive'
      else roster.hierarchy_level
    end,
    roster.team
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Backfill: profile row for the head user if it was created before
--    this trigger existed.
insert into public.users (id, email, role, hierarchy_level, team)
select id, email, 'Admin', 'Executive', 'Leadership'
from auth.users where email = 'singhshatrughna.singh22@gmail.com'
on conflict (id) do update set role = 'Admin', hierarchy_level = 'Executive';

-- 4. Minimum RLS so login role-routing works: users read their own row;
--    admins read all rows (needed for team management).
alter table public.users enable row level security;

drop policy if exists "read own profile" on public.users;
create policy "read own profile" on public.users
  for select using (id = auth.uid());

drop policy if exists "admins read all profiles" on public.users;
create policy "admins read all profiles" on public.users
  for select using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'Admin')
  );

drop policy if exists "admins update profiles" on public.users;
create policy "admins update profiles" on public.users
  for update using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'Admin')
  );
