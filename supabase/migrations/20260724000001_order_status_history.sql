-- Order status history: an append-only audit trail of production_status
-- changes, replacing the prototype's in-object timeline: [] array. One row
-- is written whenever an order is created (its initial status) and whenever
-- PATCH /orders/:id/status changes it. `label` is a snapshot of the
-- human-readable label at the time of the change (not recomputed later),
-- since an audit trail should show what the status was called when it
-- happened, not what it's called today.

create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  status text not null check (status in (
    'design_pending', 'design_approved', 'fabric_purchased', 'cutting', 'stitching',
    'hand_work', 'machine_work', 'finishing', 'quality_check', 'ready_for_delivery', 'delivered'
  )),
  label text not null,
  changed_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

grant select, insert on public.order_status_history to service_role;
grant select on public.order_status_history to authenticated;

alter table public.order_status_history enable row level security;

-- Row scoping mirrors orders_select_scoped: owner_manager/accountant see
-- every order's history, designer/master_tailor only their assigned orders'.
create policy order_status_history_select_scoped on public.order_status_history
  for select
  using (
    exists (
      select 1 from public.orders o
      join public.profiles p on p.id = auth.uid()
      where o.id = public.order_status_history.order_id
        and (
          p.role in ('owner_manager', 'accountant')
          or (p.role = 'designer' and o.designer_id = auth.uid())
          or (p.role = 'master_tailor' and o.master_tailor_id = auth.uid())
        )
    )
  );

-- No client-side insert/update/delete: history rows are only ever written by
-- apps/api's orders routes (service-role key) alongside the order's own
-- production_status update, inside one transaction -- see
-- DrizzleOrdersRepository.create()/updateStatus().
