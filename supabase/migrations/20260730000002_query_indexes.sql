-- Supporting indexes for the dashboard / list / revenue query paths added in
-- the manual-testing-fixes passes. Orders and payments are low-write tables, so
-- these are cheap to maintain, and they back access patterns that run on core
-- pages -- keeping them fast as the data grows past the demo size (the planner
-- correctly seq-scans today only because the tables are tiny).

-- The orders list is ALWAYS sorted newest-first (every /orders and bucket page),
-- and the "This Month" bucket filters on created_at.
create index if not exists orders_created_at_idx on public.orders (created_at desc);

-- Pending-payments page + payment_overdue/payment_upcoming buckets scan open
-- balances by their next-payment date. Partial index: only rows that can still
-- be outstanding (most orders eventually settle), keeping it small.
create index if not exists orders_open_next_payment_idx
  on public.orders (next_payment_date)
  where payment_status <> 'fully_paid';

-- The revenue report filters + groups payments by paid_at over a date range;
-- payments is the fastest-growing table (multiple entries per order).
create index if not exists payments_paid_at_idx on public.payments (paid_at);
