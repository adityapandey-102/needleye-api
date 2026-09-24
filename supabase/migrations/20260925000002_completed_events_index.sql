-- Found by the query audit (npm run test:perf): the staff report's weekly
-- "completed" count needs the completion events inside one month. The only
-- history index is (order_id, created_at), so that meant reading the whole
-- order_status_history table (14 rows per order, forever). This partial index
-- holds just the completion events, ordered by time -- one short range read.
--
-- The predicate must match COMPLETED_CANONICAL_STAGES in src/domain/
-- order-status.ts (today: delivered). If that list changes, change this index
-- in a new migration; the query audit will flag the scan if they drift.
create index if not exists order_status_history_completed_idx
  on public.order_status_history (created_at)
  where status = 'delivered';
