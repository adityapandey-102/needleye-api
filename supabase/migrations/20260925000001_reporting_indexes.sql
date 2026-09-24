-- Two indexes found by the query audit (npm run test:perf, docs/performance/).
--
-- 1. OPEN orders. Undelivered orders stay a small, roughly constant set (a few
--    hundred) while delivered orders grow forever. The owner's team-status
--    report only ever looks at open orders; without this, it reads every order
--    ever booked. A partial index holds only the open rows, so its cost stays
--    flat as the years pile up. `created_by` is included so the designer
--    side of the report is answered from the index alone.
create index if not exists orders_open_created_idx
  on public.orders (created_at)
  include (created_by)
  where production_status <> 'delivered';

-- 2. "Last seen": the latest audit action of one person. The old single-column
--    index found all of a person's rows and then sorted them (thousands for a
--    busy person after a year); with created_at in the key it is one probe.
--    It also covers everything the old index served (actor_id is the leading
--    column, e.g. the ON DELETE SET NULL lookup), so that one is dropped
--    rather than kept as a duplicate every insert has to maintain.
create index if not exists audit_log_actor_created_idx
  on public.audit_log (actor_id, created_at desc);

drop index if exists public.audit_log_actor_idx;
