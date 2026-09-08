-- Companion to 20260805000001: the previous migration widened the CHECK on
-- `orders.production_status` to allow 'falls_kutchu', but `order_status_history`
-- carries its OWN independent CHECK on `status` (from 20260724000001), which was
-- missed. `updateStatus` writes both tables in one transaction, so a status
-- change to Falls / Kutchu succeeded on `orders` but rolled back on the history
-- insert. Widen the history constraint the same way so both agree.

alter table public.order_status_history drop constraint if exists order_status_history_status_check;

alter table public.order_status_history add constraint order_status_history_status_check check (
  status in (
    'design_pending', 'design_approved', 'falls_kutchu', 'fabric_purchased', 'cutting',
    'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check',
    'ready_for_delivery', 'delivered'
  )
);
