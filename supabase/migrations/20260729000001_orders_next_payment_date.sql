-- Payment-due tracking: the date the next payment on this order is expected.
-- Nullable -- only meaningful while an order still has an outstanding balance;
-- the app derives "Upcoming / Due Today / Overdue" (+ days) from this vs today,
-- and the remaining payable amount from total_amount - SUM(payments) (never
-- stored). Set on the order (create/edit); displayed read-only in the ledger.

alter table public.orders
  add column next_payment_date date;
