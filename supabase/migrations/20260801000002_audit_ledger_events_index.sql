-- Backs the ledger-activity feed (GET /orders/ledger-events): payment audit
-- events filtered by entity_type and a created_at window, newest first. The
-- existing audit_log_entity_idx is (entity_type, entity_id) and
-- audit_log_created_at_idx is (created_at) alone -- neither covers the
-- "entity_type = 'payment' AND created_at in [from, to] ORDER BY created_at
-- DESC" access pattern well. This composite does (equality on entity_type,
-- then a range + ordering on created_at).
create index if not exists audit_log_entity_type_created_at_idx
  on public.audit_log (entity_type, created_at desc);
