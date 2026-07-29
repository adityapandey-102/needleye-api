-- Optimistic locking for order edits. `version` starts at 0 and the API
-- increments it on every update, using WHERE id = ? AND version = ? so a
-- second concurrent edit (which still holds the old version) affects 0 rows
-- and is rejected with ORDER_MODIFIED instead of silently clobbering the
-- first edit. A dedicated integer column (rather than comparing updated_at)
-- avoids timestamp-precision round-tripping issues between Postgres and JS.

alter table public.orders
  add column version integer not null default 0;
