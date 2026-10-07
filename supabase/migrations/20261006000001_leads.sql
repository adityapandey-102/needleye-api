-- Leads: enquiries from the public enquiry form or added by the owner, worked
-- by designers until they become an order (or are lost / discarded).
-- Decisions: docs/adr/0007-leads-and-public-enquiry-form.md.
--
-- Access model (same as payments / audit_log): every read and write goes
-- through needleye-api with the service role; browsers -- including the public
-- enquiry form -- never touch these tables directly. RLS is ON with no
-- policies, so the anon and authenticated roles see nothing even with a key.

create table public.lead_counters (
  year int primary key,
  next_seq int not null default 1
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  -- LEAD-{year}-{seq}, filled by the leads_set_lead_number trigger below.
  lead_number text not null unique,
  customer_name text not null check (char_length(customer_name) between 1 and 80),
  -- A 10-digit Indian mobile number, normalised by the API (no +91, spaces, 0).
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  requirement text not null default '' check (char_length(requirement) <= 1000),
  source text not null check (source in ('public_form', 'walk_in', 'phone_call', 'instagram', 'whatsapp', 'referral', 'other')),
  status text not null default 'new'
    check (status in ('new', 'assigned', 'unattended', 'attended', 'follow_up', 'converted', 'lost', 'discarded')),
  assigned_to uuid references public.profiles (id) on delete set null,
  assigned_at timestamptz,
  -- A repeat enquiry from the same phone within 24 hours marks the lead urgent;
  -- contacting the customer (attended / follow-up / lost / converted) clears it.
  urgent boolean not null default false,
  -- Public-form enquiries folded into this lead within its 24-hour window (max 2).
  enquiry_count int not null default 1 check (enquiry_count >= 1),
  first_enquiry_at timestamptz not null default now(),
  last_enquiry_at timestamptz not null default now(),
  follow_up_on date,
  lost_reason text check (char_length(lost_reason) <= 300),
  converted_order_id uuid references public.orders (id) on delete set null,
  -- Null = arrived through the public enquiry form.
  created_by uuid references public.profiles (id) on delete set null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Owner's lists by stage, newest first.
create index leads_status_created_idx on public.leads (status, created_at desc);
-- A designer's own leads (and their badge count), newest first.
create index leads_assigned_status_created_idx on public.leads (assigned_to, status, created_at desc);
-- The public form's same-phone, 24-hour check.
create index leads_phone_first_enquiry_idx on public.leads (phone, first_enquiry_at desc);
-- Search by name / phone / lead number (pg_trgm, already enabled for orders).
create index leads_customer_name_trgm_idx on public.leads using gin (customer_name gin_trgm_ops);
create index leads_phone_trgm_idx on public.leads using gin (phone gin_trgm_ops);
create index leads_lead_number_trgm_idx on public.leads using gin (lead_number gin_trgm_ops);

create or replace function public.set_lead_number()
returns trigger
language plpgsql
as $$
declare
  current_year int := extract(year from now());
  seq int;
begin
  insert into public.lead_counters (year, next_seq)
  values (current_year, 2)
  on conflict (year) do update set next_seq = public.lead_counters.next_seq + 1
  returning next_seq - 1 into seq;

  -- At least 3 digits, never truncated (see 20260925000003 for the order-number bug this avoids).
  new.lead_number := 'LEAD-' || current_year || '-' || lpad(seq::text, greatest(3, length(seq::text)), '0');
  return new;
end;
$$;

create trigger leads_set_lead_number
  before insert on public.leads
  for each row execute function public.set_lead_number();

-- Comments: a running log per lead (each follow-up call, visit, note). Append-only.
create table public.lead_comments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index lead_comments_lead_created_idx on public.lead_comments (lead_id, created_at);

-- History: what happened to the lead and who did it. Append-only.
create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  -- Null = the public enquiry form (no signed-in person).
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('created', 'enquiry_merged', 'assigned', 'status_changed', 'converted')),
  from_status text,
  to_status text,
  assigned_to uuid references public.profiles (id) on delete set null,
  -- e.g. a merged enquiry's requirement, a lost reason, a follow-up date.
  note text check (char_length(note) <= 1200),
  created_at timestamptz not null default now()
);

create index lead_events_lead_created_idx on public.lead_events (lead_id, created_at);

grant select, insert, update on public.lead_counters to service_role;
grant select, insert, update, delete on public.leads to service_role;
grant select, insert on public.lead_comments to service_role;
grant select, insert on public.lead_events to service_role;

alter table public.lead_counters enable row level security;
alter table public.leads enable row level security;
alter table public.lead_comments enable row level security;
alter table public.lead_events enable row level security;
