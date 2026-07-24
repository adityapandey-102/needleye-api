-- Supports: (1) Owner/Manager creating accounts directly with a generated
-- password instead of an email invite, (2) knowing whether an owner_manager/
-- accountant account has completed its first login (gates whether
-- "generate password" stays available for it), (3) QR-code login for
-- master_tailor accounts.

alter table public.profiles
  add column last_login_at timestamptz;

-- qr_token_hash intentionally does NOT live on public.profiles: that table's
-- profiles_select_active_team policy lets every authenticated user read
-- every other active profile row (needed for team-member lookups), which
-- would leak this secret to any logged-in user if it were just a column
-- here. A separate table with no anon/authenticated grant at all keeps it
-- reachable only through this API's service-role-key repository code.
create table public.qr_login_tokens (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.qr_login_tokens to service_role;
-- No grant to anon/authenticated -- this table is never reachable via the
-- Data API except through the service-role client.

alter table public.qr_login_tokens enable row level security;
-- No policies defined: RLS defaults to deny-all, which is what we want here
-- (defense in depth on top of the missing grant above).
