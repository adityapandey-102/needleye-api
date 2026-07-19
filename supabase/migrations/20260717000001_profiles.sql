-- Profiles: 1:1 with auth.users, holds the RBAC role that authorizes every
-- other table in this schema. role is never trusted from client-writable
-- user_metadata; it lives here and only Owner/Manager (via the service-role
-- key, see apps/api users routes) can change it after invite time.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null check (role in ('owner_manager', 'designer', 'master_tailor', 'accountant')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- Fires on every new auth.users row. The intended role/full name are set in
-- user_metadata at invite time by apps/api's /users/invite endpoint (via the
-- Supabase Admin API), so this trigger just copies them across.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    new.email,
    coalesce(new.raw_user_meta_data ->> 'role', 'designer')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- This CLI/project defaults to NOT auto-exposing new public-schema tables to
-- the Data API roles (anon/authenticated/service_role) without explicit
-- GRANTs -- that now applies even to service_role. RLS policies below still
-- gate what anon/authenticated can see; service_role bypasses RLS but still
-- needs the GRANT to reach the table at all via PostgREST/supabase-js.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.profiles to service_role;
grant select on public.profiles to authenticated;

alter table public.profiles enable row level security;

-- Every authenticated user can read their own profile (needed for the
-- client to know its own role) and, for team-member lookups (designer/master
-- selects, filters), every authenticated user can read active profiles.
create policy profiles_select_self on public.profiles
  for select
  using (auth.uid() = id);

create policy profiles_select_active_team on public.profiles
  for select
  using (active = true);

-- No client-side insert/update/delete: profile creation is via the trigger
-- above, and all mutation (role changes, deactivation) goes through
-- apps/api's users routes using the service-role key, which bypasses RLS.
