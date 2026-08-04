-- Composite indexes backing the per-staff workload report (GET /orders/staff-report):
-- it filters a person's orders by designer_id / master_tailor_id and buckets
-- them by created_at week over a rolling window. These cover that access path
-- so the report stays fast as order volume grows (the existing single-column
-- designer/master indexes don't help the created_at bucketing).

create index if not exists orders_designer_created_at_idx
  on public.orders (designer_id, created_at);

create index if not exists orders_master_tailor_created_at_idx
  on public.orders (master_tailor_id, created_at);
