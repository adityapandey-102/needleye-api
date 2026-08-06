-- Adds the new granular production status 'falls_kutchu' (label "Falls / Kutchu"),
-- which sits after 'design_approved' in the order lifecycle. The status is a
-- production-stage step (advanced by the Master Tailor / Owner-Manager), and
-- gets its own canonical Kanban column + progress-tracker node in the domain
-- vocabulary (src/domain/order-status.ts).
--
-- The original `production_status` CHECK constraint (20260717000002_orders.sql)
-- was an inline column check, so Postgres named it `orders_production_status_check`.
-- Swap it for one that also allows the new value. Idempotent-ish: drop-if-exists
-- then re-add.

alter table public.orders drop constraint if exists orders_production_status_check;

alter table public.orders add constraint orders_production_status_check check (
  production_status in (
    'design_pending', 'design_approved', 'falls_kutchu', 'fabric_purchased', 'cutting',
    'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check',
    'ready_for_delivery', 'delivered'
  )
);
