-- Business audit trail: an append-only record of important business actions
-- (logins, order/payment/user changes, ...), distinct from application logs.
-- Application logs (pino -> stdout) help developers debug; this table helps
-- the business answer "who did what, when." Written by apps/api's AuditLogger
-- (common/audit) on every audited action, correlated to the app logs by
-- request_id.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Who performed the action. Null for unauthenticated/system actions
  -- (e.g. a failed login has no actor yet). Not a FK with ON DELETE CASCADE:
  -- an audit record must survive the deletion of the actor's profile.
  actor_id uuid references public.profiles (id) on delete set null,
  -- What happened, as a stable dotted code, e.g. 'order.created', 'user.role_changed'.
  action text not null,
  -- The kind of entity affected, e.g. 'order', 'payment', 'user'.
  entity_type text not null,
  -- The affected entity's id (text, since some ids aren't uuids). Null where N/A.
  entity_id text,
  -- Correlates this audit record with the application logs for the same request.
  request_id text,
  -- Small, optional structured context (e.g. { from, to } for a role change).
  -- Deliberately NOT a place to dump whole entities -- keep it minimal.
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_actor_idx on public.audit_log (actor_id);
create index audit_log_created_at_idx on public.audit_log (created_at desc);

-- Only the API (service-role) writes and reads audit records. There is no
-- client-facing audit endpoint in scope, so the anon/authenticated Data-API
-- roles get no grant at all.
grant select, insert on public.audit_log to service_role;

alter table public.audit_log enable row level security;
-- RLS enabled with no policy: denies all access via the Data API by default.
-- The API reaches this table only through the service-role connection, which
-- bypasses RLS -- this is purely to ensure no anon/authenticated path exists.
