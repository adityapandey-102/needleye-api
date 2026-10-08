-- Daily ledger totals (ADR 0008, phase 4).
--
-- One row per SHOP day (order booking_date / payment paid_at are already shop
-- days), kept up to date by the database itself:
--
--   orders_booked   orders booked that day
--   orders_priced   of those, how many have a price
--   booked_total    the value of those orders (their totals, as priced now)
--   paid_on_booked  everything paid so far -- on any date -- on those orders
--   cash_collected  money received that day (payments dated that day), any order
--   payments_count  how many payments are dated that day
--
-- The Revenue page reads months as sums of these rows: a few hundred small rows
-- instead of every order and payment. Outstanding = booked_total -
-- paid_on_booked (payments never exceed a total, so it is never negative).
--
-- Triggers on orders and payments apply each change as a delta, in the SAME
-- transaction as the change. They are SECURITY DEFINER and the app has no write
-- grant on the table: totals move only through orders and payments. They are
-- ENABLE ALWAYS, so they also fire when a session runs with
-- session_replication_role = replica (the integration-test cleanup does that to
-- step past the delivered-payments lock) -- the totals can't drift that way.
--
-- The days one write touches are locked in DAY ORDER before they change, so two
-- writes touching the same two days always lock them in the same order. The
-- table's checks (never negative) hold on the final totals after every write.
--
-- The triggers are created BEFORE the backfill, in this one transaction:
-- creating them locks orders and payments against writes until commit, so the
-- backfill sees a still picture and nothing lands between the two.

create table public.ledger_daily (
  day date primary key,
  orders_booked integer not null default 0 check (orders_booked >= 0),
  orders_priced integer not null default 0 check (orders_priced >= 0 and orders_priced <= orders_booked),
  booked_total numeric(14, 2) not null default 0 check (booked_total >= 0),
  paid_on_booked numeric(14, 2) not null default 0 check (paid_on_booked >= 0),
  cash_collected numeric(14, 2) not null default 0 check (cash_collected >= 0),
  payments_count integer not null default 0 check (payments_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.ledger_daily enable row level security;
-- No policies: API-only. Read-only for the app; only the triggers write.
grant select on public.ledger_daily to service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'needleye_app') then
    grant select on public.ledger_daily to needleye_app;
    revoke insert, update, delete, truncate on public.ledger_daily from needleye_app;
  end if;
end;
$$;

-- Applies a set of per-day deltas (rows: day, orders, priced, booked,
-- paid_on_booked, cash, payments). Not one upsert: an upsert checks the
-- table's constraints against the proposed DELTA row, and a delta may be
-- negative. So: create missing days as zeros, lock the days in day order,
-- then add the deltas -- the checks then judge the final totals.
create or replace function public.ledger_apply(deltas jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ledger_daily (day)
  select distinct (d ->> 'day')::date from jsonb_array_elements(deltas) d
  order by 1
  on conflict (day) do nothing;

  perform 1 from public.ledger_daily l
  where l.day in (select (d ->> 'day')::date from jsonb_array_elements(deltas) d)
  order by l.day
  for update;

  update public.ledger_daily l set
    orders_booked = l.orders_booked + g.orders,
    orders_priced = l.orders_priced + g.priced,
    booked_total = l.booked_total + g.booked,
    paid_on_booked = l.paid_on_booked + g.paid_on_booked,
    cash_collected = l.cash_collected + g.cash,
    payments_count = l.payments_count + g.payments,
    updated_at = now()
  from (
    select
      (d ->> 'day')::date as day,
      sum((d ->> 'orders')::int) as orders,
      sum((d ->> 'priced')::int) as priced,
      sum((d ->> 'booked')::numeric) as booked,
      sum((d ->> 'paid_on_booked')::numeric) as paid_on_booked,
      sum((d ->> 'cash')::numeric) as cash,
      sum((d ->> 'payments')::int) as payments
    from jsonb_array_elements(deltas) d
    group by 1
  ) g
  where l.day = g.day;
end;
$$;

-- One delta row (all zeros except what's given).
create or replace function public.ledger_delta(
  p_day date,
  p_orders int default 0,
  p_priced int default 0,
  p_booked numeric default 0,
  p_paid_on_booked numeric default 0,
  p_cash numeric default 0,
  p_payments int default 0
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'day', p_day, 'orders', p_orders, 'priced', p_priced, 'booked', p_booked,
    'paid_on_booked', p_paid_on_booked, 'cash', p_cash, 'payments', p_payments
  );
$$;

-- Orders: a booking adds to its day; a price change moves that day's value;
-- a booking-date change moves the order (and what's been paid on it) between days.
create or replace function public.ledger_on_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  paid numeric := 0;
begin
  if tg_op = 'INSERT' then
    perform public.ledger_apply(jsonb_build_array(public.ledger_delta(
      new.booking_date, 1, (new.total_amount is not null)::int, coalesce(new.total_amount, 0))));
    return new;
  end if;

  if tg_op = 'DELETE' then
    select coalesce(sum(p.amount), 0) into paid from public.payments p where p.order_id = old.id;
    perform public.ledger_apply(jsonb_build_array(public.ledger_delta(
      old.booking_date, -1, -((old.total_amount is not null)::int), -coalesce(old.total_amount, 0), -paid)));
    return old;
  end if;

  -- UPDATE
  if new.booking_date is distinct from old.booking_date then
    select coalesce(sum(p.amount), 0) into paid from public.payments p where p.order_id = new.id;
    perform public.ledger_apply(jsonb_build_array(
      public.ledger_delta(old.booking_date, -1, -((old.total_amount is not null)::int), -coalesce(old.total_amount, 0), -paid),
      public.ledger_delta(new.booking_date, 1, (new.total_amount is not null)::int, coalesce(new.total_amount, 0), paid)));
  elsif new.total_amount is distinct from old.total_amount then
    perform public.ledger_apply(jsonb_build_array(public.ledger_delta(
      new.booking_date, 0,
      (new.total_amount is not null)::int - (old.total_amount is not null)::int,
      coalesce(new.total_amount, 0) - coalesce(old.total_amount, 0))));
  end if;
  return new;
end;
$$;

-- Payments: cash on the payment's own day, and "paid so far" on its order's booking day.
create or replace function public.ledger_on_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  deltas jsonb := '[]'::jsonb;
  booked_on date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select o.booking_date into booked_on from public.orders o where o.id = old.order_id;
    deltas := deltas
      || jsonb_build_array(public.ledger_delta(old.paid_at, p_cash => -old.amount, p_payments => -1))
      || case when booked_on is not null
           then jsonb_build_array(public.ledger_delta(booked_on, p_paid_on_booked => -old.amount))
           else '[]'::jsonb end;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select o.booking_date into booked_on from public.orders o where o.id = new.order_id;
    deltas := deltas
      || jsonb_build_array(public.ledger_delta(new.paid_at, p_cash => new.amount, p_payments => 1))
      || jsonb_build_array(public.ledger_delta(booked_on, p_paid_on_booked => new.amount));
  end if;
  -- An update that changed none of amount / date / order nets to zero -- skip the write.
  if tg_op = 'UPDATE' and new.amount = old.amount and new.paid_at = old.paid_at and new.order_id = old.order_id then
    return new;
  end if;
  perform public.ledger_apply(deltas);
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger orders_ledger
  after insert or delete or update of booking_date, total_amount on public.orders
  for each row execute function public.ledger_on_order();
alter table public.orders enable always trigger orders_ledger;

create trigger payments_ledger
  after insert or update or delete on public.payments
  for each row execute function public.ledger_on_payment();
alter table public.payments enable always trigger payments_ledger;

-- Backfill from what's there now (writes are blocked until this transaction commits).
insert into public.ledger_daily (day, orders_booked, orders_priced, booked_total, paid_on_booked, cash_collected, payments_count)
select day, sum(orders), sum(priced), sum(booked), sum(paid_on_booked), sum(cash), sum(payments)
from (
  select o.booking_date as day, count(*)::int as orders, count(o.total_amount)::int as priced,
         coalesce(sum(o.total_amount), 0) as booked, 0::numeric as paid_on_booked, 0::numeric as cash, 0 as payments
  from public.orders o
  group by o.booking_date
  union all
  select o.booking_date, 0, 0, 0, sum(p.amount), 0, 0
  from public.payments p
  join public.orders o on o.id = p.order_id
  group by o.booking_date
  union all
  select p.paid_at, 0, 0, 0, 0, sum(p.amount), count(*)::int
  from public.payments p
  group by p.paid_at
) x
group by day;
