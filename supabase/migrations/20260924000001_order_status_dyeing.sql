-- Adds the production stage 'dyeing' (label "Dyeing"), between 'fabric_purchased'
-- and 'cutting' -- the flow grows from 13 stages to 14. It is a floor stage,
-- gated by the production tier (owner / designer / PM / master tailor / worker),
-- same as the stages either side of it. See src/domain/order-status.ts.
--
-- Only the two CHECK constraints need to change: production_status is plain text,
-- so the new value is purely a matter of what the constraints allow.
--
--   1) orders.production_status
--   2) order_status_history.status -- every stage change also writes a history
--      row carrying the stage value, and this table carries the same list.
--
-- Additive and safe to run BEFORE the code that uses it is deployed: the new
-- constraint is a strict superset of the old one, so every existing row still
-- passes and the currently deployed app (which never writes 'dyeing') is
-- unaffected. No data is rewritten.

-- 1) orders.production_status: the 14-stage set.
alter table public.orders drop constraint if exists orders_production_status_check;
alter table public.orders add constraint orders_production_status_check check (
  production_status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'dyeing', 'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check', 'alteration',
    'delivered'
  )
);

-- 2) order_status_history.status: same 14-stage set (append-only audit trail).
alter table public.order_status_history drop constraint if exists order_status_history_status_check;
alter table public.order_status_history add constraint order_status_history_status_check check (
  status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'dyeing', 'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check', 'alteration',
    'delivered'
  )
);
