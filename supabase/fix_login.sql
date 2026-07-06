-- FIX: employee-portal login lands in the client portal.
-- Root cause: the RLS policies in setup.sql queried public.users from
-- within a policy ON public.users -> Postgres "infinite recursion
-- detected in policy" -> every profile read fails -> role resolves to
-- null -> app treats everyone as Client.
-- Run in Supabase Dashboard -> SQL Editor. Idempotent. Run AFTER setup.sql.

-- 1. Security-definer helpers evaluate role checks OUTSIDE RLS,
--    breaking the recursion.
create or replace function public.current_user_role()
returns text language sql security definer stable set search_path = public as $$
  select role from public.users where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select role from public.users where id = auth.uid()) = 'Admin', false)
$$;

-- 2. Replace the recursive policies on public.users.
drop policy if exists "read own profile" on public.users;
drop policy if exists "admins read all profiles" on public.users;
drop policy if exists "admins update profiles" on public.users;

create policy "read own profile" on public.users
  for select using (id = auth.uid());

create policy "admins read all profiles" on public.users
  for select using (public.is_admin());

create policy "admins update profiles" on public.users
  for update using (public.is_admin());

-- 3. Same fix for the roster policy (queried users; now uses the helper).
drop policy if exists "admins manage roster" on public.employee_roster;
create policy "admins manage roster" on public.employee_roster
  for all using (public.is_admin());

-- 4. Verify (run as a logged-in user via the app, or check here):
--    select public.current_user_role();  -- should return your role
--    Backfill check: the head account must have an Admin row.
select id, email, role, hierarchy_level from public.users
where email = 'singhshatrughna.singh22@gmail.com';
