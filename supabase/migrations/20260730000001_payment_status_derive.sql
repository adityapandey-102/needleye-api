-- Payment status is now DERIVED from the ledger (sum of payments vs order
-- total), never chosen by hand. Retire 'partially_paid', introduce 'unpaid',
-- and recompute every existing order's status from its actual recorded
-- payments so the stored column matches the ledger exactly.

alter table public.orders drop constraint if exists orders_payment_status_check;

update public.orders o
set payment_status = case
  when o.total_amount <= 0 then 'unpaid'
  when coalesce(p.paid, 0) >= o.total_amount then 'fully_paid'
  when coalesce(p.paid, 0) > 0 then 'advance_paid'
  else 'unpaid'
end
from (
  select o2.id, coalesce(sum(pm.amount), 0) as paid
  from public.orders o2
  left join public.payments pm on pm.order_id = o2.id
  group by o2.id
) p
where p.id = o.id;

alter table public.orders
  add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'advance_paid', 'fully_paid'));
