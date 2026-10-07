-- Adds two production stages and one database rule (ADR 0008, phase 1):
--
--   'marking' (label "Marking") -- between 'dyeing' and 'cutting', production tier.
--   'ready'   (label "Ready")   -- between 'alteration' and 'delivered', finalization
--                                 tier. The main path is QC -> Ready -> Delivered;
--                                 Ready -> Alteration -> Ready may repeat.
--
--   Delivered only from Ready -- enforced here as well as in the API, so no other
--   path (a script, a manual SQL fix, a future endpoint) can skip it.
--
-- Additive and safe to run BEFORE the code that uses it is deployed: the new
-- CHECK sets are strict supersets of the old ones, so every existing row still
-- passes. No data is rewritten -- orders already in QC or Alteration simply go
-- through Ready before Delivered.
--
-- !! Deploy note: the trigger refuses <anything> -> 'delivered' except from
-- 'ready'. The currently deployed app has no Ready stage, so between this
-- migration and the new API going live nobody can mark an order Delivered.
-- Run it right before deploying the API (see docs/cutover-checklist.md).

-- 1) orders.production_status: the 16-stage set.
alter table public.orders drop constraint if exists orders_production_status_check;
alter table public.orders add constraint orders_production_status_check check (
  production_status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'dyeing', 'marking', 'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check',
    'alteration', 'ready', 'delivered'
  )
);

-- 2) order_status_history.status: the same 16-stage set (append-only trail).
alter table public.order_status_history drop constraint if exists order_status_history_status_check;
alter table public.order_status_history add constraint order_status_history_status_check check (
  status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'dyeing', 'marking', 'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check',
    'alteration', 'ready', 'delivered'
  )
);

-- 3) Delivered only from Ready. Fires only when the stage actually changes, so
--    edits to other columns of a delivered order are unaffected. Inserts aren't
--    checked: a new order always starts at the beginning of the flow (the API
--    sets it), and seeds / tests may insert finished history directly.
create or replace function public.orders_guard_stage_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.production_status = 'delivered'
     and old.production_status is distinct from 'ready'
     and old.production_status is distinct from 'delivered' then
    raise exception 'An order can only be delivered from Ready (it is at %)', old.production_status
      using errcode = 'check_violation', constraint = 'orders_deliver_requires_ready';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_stage_change on public.orders;
create trigger orders_guard_stage_change
  before update of production_status on public.orders
  for each row
  when (new.production_status is distinct from old.production_status)
  execute function public.orders_guard_stage_change();
