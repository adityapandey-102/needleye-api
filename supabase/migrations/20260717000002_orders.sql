-- Orders: the core record. designer_id/master_tailor_id are FKs to
-- profiles (replacing the prototype's two hardcoded 5-name <select> lists).
-- production_status always holds one of the 11 granular values (see
-- packages/shared/src/constants/orderStatus.ts) -- the 9-stage Kanban
-- grouping is derived at read time, never stored redundantly.

create table public.order_counters (
  year int primary key,
  next_seq int not null default 1
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,

  customer_name text not null,
  phone text not null check (phone ~ '^\d{10}$'),
  bill_number text not null,

  booking_date date not null default current_date,
  due_date date not null,

  designer_id uuid not null references public.profiles (id),
  master_tailor_id uuid not null references public.profiles (id),

  product_category text not null check (product_category in (
    'designer_blouse', 'saree', 'bridal_lehenga', 'custom_ethnic_wear', 'boutique_fashion'
  )),
  order_details text not null,

  hand_work boolean not null default false,
  machine_work boolean not null default false,
  purchase_required boolean not null default false,

  payment_status text not null check (payment_status in ('advance_paid', 'partially_paid', 'fully_paid')),
  total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),

  production_status text not null default 'design_pending' check (production_status in (
    'design_pending', 'design_approved', 'fabric_purchased', 'cutting', 'stitching',
    'hand_work', 'machine_work', 'finishing', 'quality_check', 'ready_for_delivery', 'delivered'
  )),

  designer_instructions text,
  special_notes text,

  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index orders_designer_idx on public.orders (designer_id);
create index orders_master_tailor_idx on public.orders (master_tailor_id);
create index orders_production_status_idx on public.orders (production_status);
create index orders_due_date_idx on public.orders (due_date);

create trigger orders_set_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();

-- Collision-safe ORD-{year}-{seq:03d} generation: a locking upsert on
-- order_counters serializes concurrent inserts onto one row instead of
-- racing on a client-side max(existing)+1 (what the prototype did).
create or replace function public.set_order_number()
returns trigger
language plpgsql
as $$
declare
  current_year int := extract(year from now());
  seq int;
begin
  insert into public.order_counters (year, next_seq)
  values (current_year, 2)
  on conflict (year) do update set next_seq = public.order_counters.next_seq + 1
  returning next_seq - 1 into seq;

  new.order_number := 'ORD-' || current_year || '-' || lpad(seq::text, 3, '0');
  return new;
end;
$$;

create trigger orders_set_order_number
  before insert on public.orders
  for each row
  execute function public.set_order_number();

grant select, insert, update, delete on public.orders to service_role;
grant select on public.orders to authenticated;
grant select, insert, update on public.order_counters to service_role;

alter table public.orders enable row level security;
alter table public.order_counters enable row level security;

-- Row scoping mirrors the capability matrix: owner_manager/accountant see
-- everything, designer/master_tailor see only orders assigned to them.
-- This is defense-in-depth -- the primary enforcement is Express's
-- capability-matrix middleware, which is the only thing that can express
-- field-level edit rules RLS can't (e.g. pricing/assignment fields).
create policy orders_select_scoped on public.orders
  for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          p.role in ('owner_manager', 'accountant')
          or (p.role = 'designer' and public.orders.designer_id = auth.uid())
          or (p.role = 'master_tailor' and public.orders.master_tailor_id = auth.uid())
        )
    )
  );

-- No client-side insert/update/delete: all writes go through apps/api's
-- orders routes using the service-role key, which applies the capability
-- matrix's field-level rules before touching the row.
