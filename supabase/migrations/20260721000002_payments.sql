-- Payment ledger: multiple dated entries per order, replacing the single
-- total/paid number pair. amount_paid/outstanding are always derived
-- (SUM(payments.amount), total_amount - SUM) by the API -- never stored
-- redundantly here. The "fully_paid must reconcile with the ledger" rule is
-- application logic (apps/api's PaymentsService/OrdersService), not
-- something a CHECK constraint can express across two tables.

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  method text not null check (method in ('cash', 'card', 'upi', 'bank_transfer', 'cheque', 'other')),
  paid_at date not null default current_date,
  recorded_by uuid references public.profiles (id),
  notes text,
  created_at timestamptz not null default now()
);

create index payments_order_idx on public.payments (order_id);

grant select, insert, update, delete on public.payments to service_role;
grant select on public.payments to authenticated;

alter table public.payments enable row level security;

-- Deliberately no master_tailor branch at all -- zero payment visibility is
-- enforced here too (defense in depth), not just by the API's capability
-- matrix. Designer is scoped to their own assigned orders, matching
-- orders_select_scoped.
create policy payments_select_scoped on public.payments
  for select
  using (
    exists (
      select 1 from public.orders o
      join public.profiles p on p.id = auth.uid()
      where o.id = public.payments.order_id
        and (
          p.role in ('owner_manager', 'accountant')
          or (p.role = 'designer' and o.designer_id = auth.uid())
        )
    )
  );

-- No client-side insert/update/delete: all ledger writes go through apps/api's
-- payments routes using the service-role key, which enforces the fully_paid
-- consistency rule before touching a row.
