-- Separate, typed audit logs (ADR 0008, phase 3).
--
-- Until now every business event went to one best-effort `audit_log`, written
-- AFTER the change and outside its transaction (a crash between the two lost
-- the record), with untyped jsonb and, for order edits, no values at all.
-- From here:
--
--   payment_audit_log     every payment recorded / edited / removed: typed
--                         amount, method, paid-on date and notes, plus the
--                         previous values for an edit.
--   order_audit_log       every order created / edited / image removed: the
--                         changed fields with their before and after values.
--   order_price_history   (phase 2) every price set / raise / discount.
--   order_status_history  (existing) every stage move -- now with from_status.
--   audit_log             sign-ins, sign-outs, password changes, account and
--                         QR-card events only.
--
-- The API writes each log row in the SAME transaction as the change it
-- records. All of them are append-only.
--
-- History is COPIED, never moved: past order.* / payment.* rows stay in
-- audit_log untouched (nothing is deleted); their content is also copied into
-- the new logs so the Ledger Activity and the daily activity feed keep their
-- history. Stage moves and price changes need no copy -- order_status_history
-- and order_price_history already hold them.

-- 0) Shared append-only guard for the new logs. Updates and deletes are
--    refused, except when a parent row's foreign-key action cascades into the
--    log (trigger depth > 1): an order delete (the app never deletes orders,
--    and one with payments can't be) or an account delete nulling actor_id.
create or replace function public.append_only_log()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception '% is append-only', tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- 1) order_audit_log.
create table public.order_audit_log (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  action text not null check (action in ('created', 'updated', 'image_deleted')),
  -- updated: { "<field>": { "from": <before>, "to": <after> } } for each changed field.
  changes jsonb,
  -- Facts that aren't field changes: the lead it came from, a delivery-day
  -- override confirmed with the PM, the image slot removed, the initial stage.
  details jsonb,
  actor_id uuid references public.profiles (id) on delete set null,
  request_id text,
  created_at timestamptz not null default now()
);

create index order_audit_log_created_idx on public.order_audit_log (created_at);
create index order_audit_log_order_idx on public.order_audit_log (order_id, created_at);
create index order_audit_log_actor_idx on public.order_audit_log (actor_id, created_at);

-- 2) payment_audit_log.
create table public.payment_audit_log (
  id uuid primary key default gen_random_uuid(),
  -- No foreign key: a removed payment's log rows must outlive it.
  payment_id uuid not null,
  order_id uuid not null references public.orders (id) on delete cascade,
  action text not null check (action in ('created', 'updated', 'deleted')),
  -- The payment as it is after the action (created / updated), or as it was when removed (deleted).
  amount numeric(12, 2) not null check (amount > 0),
  method text not null,
  paid_at date not null,
  notes text,
  -- updated: the values before the edit.
  previous_amount numeric(12, 2) check (previous_amount > 0),
  previous_method text,
  previous_paid_at date,
  previous_notes text,
  actor_id uuid references public.profiles (id) on delete set null,
  request_id text,
  created_at timestamptz not null default now(),
  constraint payment_audit_log_previous_only_on_update check ((action = 'updated') = (previous_amount is not null))
);

create index payment_audit_log_created_idx on public.payment_audit_log (created_at);
create index payment_audit_log_order_idx on public.payment_audit_log (order_id, created_at);
create index payment_audit_log_actor_idx on public.payment_audit_log (actor_id, created_at);

-- 3) Stage moves record where they came from. Null = the order's first row
--    (its starting stage). Past rows are filled from the row before them.
alter table public.order_status_history add column from_status text;
alter table public.order_status_history add constraint order_status_history_from_status_check check (
  from_status is null or from_status in (
    'design_pending', 'design_approved', 'production_manager_received', 'falls_kutchu', 'fabric_purchased',
    'dyeing', 'marking', 'cutting', 'stitching', 'hand_work', 'machine_work', 'finishing', 'quality_check',
    'alteration', 'ready', 'delivered'
  )
);

update public.order_status_history h
set from_status = prev.status
from (
  select id, lag(status) over (partition by order_id order by created_at, id) as status
  from public.order_status_history
) prev
where prev.id = h.id
  and prev.status is not null;

-- 4) Indexes the daily activity feed (one day of each log) and the staff
--    "last seen" (each person's latest row in each log) read.
create index if not exists order_status_history_created_idx on public.order_status_history (created_at);
create index if not exists order_status_history_changed_by_idx on public.order_status_history (changed_by, created_at);
create index if not exists order_price_history_created_idx on public.order_price_history (created_at);
create index if not exists order_price_history_changed_by_idx on public.order_price_history (changed_by, created_at);
create index if not exists lead_events_created_idx on public.lead_events (created_at);
create index if not exists lead_events_actor_idx on public.lead_events (actor_id, created_at);

-- 5) Copy past order events. An order.delivery_override row was written by
--    the same request as its order.created / order.updated row -- it becomes
--    that row's details.deliveryOverride. Old edit rows only named the fields.
insert into public.order_audit_log (order_id, action, changes, details, actor_id, request_id, created_at)
select
  o.id,
  case a.action
    when 'order.created' then 'created'
    when 'order.updated' then 'updated'
    else 'image_deleted'
  end,
  null,
  (case
     when a.action = 'order.updated' then jsonb_build_object('fields', coalesce(a.metadata -> 'fields', '[]'::jsonb))
     when a.action = 'order.image_deleted' then jsonb_build_object('slot', a.metadata -> 'slot')
     else coalesce(a.metadata, '{}'::jsonb) - 'orderNumber'
   end)
  || case when ov.metadata is not null then jsonb_build_object('deliveryOverride', ov.metadata) else '{}'::jsonb end,
  a.actor_id,
  a.request_id,
  a.created_at
from public.audit_log a
join public.orders o on o.id::text = a.entity_id
left join lateral (
  select x.metadata
  from public.audit_log x
  where x.action = 'order.delivery_override'
    and x.entity_id = a.entity_id
    and x.request_id = a.request_id
  limit 1
) ov on a.request_id is not null and a.action in ('order.created', 'order.updated')
where a.entity_type = 'order'
  and a.action in ('order.created', 'order.updated', 'order.image_deleted');

-- 6) Copy past payment events. An old "recorded" row didn't carry the payment
--    date: take it from the payment (when it still exists), else the day it
--    was recorded in the shop's timezone (the app always recorded "today").
--    The earliest "removed" rows (July 2026) carried only the order id: their
--    amount, method and date come from that payment's previous log row. A row
--    with no amount anywhere is not copied (it stays in audit_log, untouched).
with legacy as (
  select
    a.*,
    case when a.action = 'payment.updated' then a.metadata -> 'after' else a.metadata end as now,
    p.amount as payment_amount,
    p.method as payment_method,
    p.paid_at as payment_paid_at,
    o.id as order_uuid
  from public.audit_log a
  join public.orders o on o.id::text = a.metadata ->> 'orderId'
  left join public.payments p on p.id::text = a.entity_id
  where a.entity_type = 'payment'
    and a.action in ('payment.created', 'payment.updated', 'payment.deleted')
    and a.entity_id ~ '^[0-9a-f-]{36}$'
),
resolved as (
  select
    l.*,
    coalesce(l.now ->> 'amount', l.payment_amount::text, prev.amount) as amount_text,
    coalesce(l.now ->> 'method', l.payment_method, prev.method, 'other') as method_text,
    coalesce((l.now ->> 'paidAt')::date, l.payment_paid_at, (prev.paid_at)::date, (l.created_at at time zone 'Asia/Kolkata')::date) as paid_on
  from legacy l
  left join lateral (
    select
      coalesce(x.metadata -> 'after' ->> 'amount', x.metadata ->> 'amount') as amount,
      coalesce(x.metadata -> 'after' ->> 'method', x.metadata ->> 'method') as method,
      coalesce(x.metadata -> 'after' ->> 'paidAt', x.metadata ->> 'paidAt') as paid_at
    from public.audit_log x
    where x.entity_type = 'payment'
      and x.entity_id = l.entity_id
      and x.action in ('payment.created', 'payment.updated')
      and x.created_at < l.created_at
    order by x.created_at desc
    limit 1
  ) prev on true
)
insert into public.payment_audit_log (
  payment_id, order_id, action, amount, method, paid_at, notes,
  previous_amount, previous_method, previous_paid_at, previous_notes,
  actor_id, request_id, created_at
)
select
  r.entity_id::uuid,
  r.order_uuid,
  replace(r.action, 'payment.', ''),
  r.amount_text::numeric(12, 2),
  r.method_text,
  r.paid_on,
  r.now ->> 'notes',
  case when r.action = 'payment.updated'
    then (coalesce(r.metadata -> 'before' ->> 'amount', r.amount_text))::numeric(12, 2) end,
  case when r.action = 'payment.updated' then r.metadata -> 'before' ->> 'method' end,
  case when r.action = 'payment.updated' then (r.metadata -> 'before' ->> 'paidAt')::date end,
  case when r.action = 'payment.updated' then r.metadata -> 'before' ->> 'notes' end,
  r.actor_id,
  r.request_id,
  r.created_at
from resolved r
where r.amount_text is not null;

-- Say how many old payment rows couldn't be copied (expected: 0).
do $$
declare
  skipped int;
begin
  select count(*) into skipped
  from public.audit_log a
  where a.entity_type = 'payment'
    and a.action in ('payment.created', 'payment.updated', 'payment.deleted')
    and not exists (select 1 from public.payment_audit_log l where l.request_id is not distinct from a.request_id
                      and l.payment_id::text = a.entity_id and l.created_at = a.created_at);
  raise notice 'payment_audit_log: % old payment event(s) not copied (missing order or amount; still in audit_log)', skipped;
end;
$$;

-- 7) Access: API-only, append-only.
grant select, insert on public.order_audit_log to service_role;
grant select, insert on public.payment_audit_log to service_role;
alter table public.order_audit_log enable row level security;
alter table public.payment_audit_log enable row level security;
-- No policies: API-only (service role / needleye_app bypass RLS).

create trigger order_audit_log_append_only
  before update or delete on public.order_audit_log
  for each row execute function public.append_only_log();
create trigger payment_audit_log_append_only
  before update or delete on public.payment_audit_log
  for each row execute function public.append_only_log();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'needleye_app') then
    grant select, insert on public.order_audit_log, public.payment_audit_log to needleye_app;
    revoke update, delete, truncate on public.order_audit_log, public.payment_audit_log from needleye_app;
  end if;
end;
$$;
