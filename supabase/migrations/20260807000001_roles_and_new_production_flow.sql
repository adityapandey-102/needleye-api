-- Two role additions + the reworked 13-stage production flow.
--
-- Roles: add `production_manager` (designer-like, but reads/edits any order) and
-- `worker` (master-like, QR-scan only). See src/domain/roles.ts + capabilities.ts.
--
-- Production flow: insert `production_manager_received` (after Design Approved)
-- and `alteration` (before Delivered), and REMOVE `ready_for_delivery`. Existing
-- orders/history sitting at `ready_for_delivery` are remapped to `delivered`
-- (product decision) BEFORE the constraints are swapped, so validation passes.

-- 1) profiles.role: allow the two new roles.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner_manager', 'designer', 'master_tailor', 'accountant', 'production_manager', 'worker'));

-- 2) Remap the removed `ready_for_delivery` stage to `delivered` everywhere,
--    including the frozen history label, before tightening the CHECKs.
update public.orders
  set production_status = 'delivered'
  where production_status = 'ready_for_delivery';
update public.order_status_history
  set status = 'delivered', label = 'Delivered'
  where status = 'ready_for_delivery';

-- 3) orders.production_status: the new 13-stage set.
alter table public.orders drop constraint if exists orders_production_status_check;
alter table public.orders add constraint orders_production_status_check check (
  production_status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check', 'alteration', 'delivered'
  )
);

-- 4) order_status_history.status: same 13-stage set (append-only audit trail).
alter table public.order_status_history drop constraint if exists order_status_history_status_check;
alter table public.order_status_history add constraint order_status_history_status_check check (
  status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check', 'alteration', 'delivered'
  )
);
