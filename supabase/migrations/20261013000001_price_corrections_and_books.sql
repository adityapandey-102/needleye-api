-- Price corrections and the books (ADR 0008, amended 2026-10-09 by the owner).
--
-- The owner simplified the money rules:
--   1. After the first price, a price change is a CORRECTION -- up or down, by
--      the Owner or the Accountant, with a reason -- never below what's been
--      collected (correct or remove a payment first). order_price_history
--      records it as 'correction' (older 'raise' / 'discount' rows stay valid).
--   2. Delivery no longer locks anything: a delivered order's price and
--      payments can still be corrected. The lock is the BOOKS:
--        - a payment can't be added, changed or removed in a closed month (its
--          own date's month -- unchanged since phase 5);
--        - an order's price can't change while its BOOKING month is closed, and
--          an order can't be booked into, or moved out of, a closed month.
--      Delivered still needs a price.
--   3. A month can't be closed while one of its orders has no price (the API
--      refuses; otherwise that order could never be priced or delivered).
--   4. The nightly check now also holds a closed month's booked orders and
--      their total to its closing record (they can no longer change), as well
--      as its cash.
--   5. Indexes for the new order-list filters (booking month / year) and the
--      "fetch customer details" lookup by phone.

-- 1) Price history: 'correction' -----------------------------------------------
alter table public.order_price_history drop constraint order_price_history_kind_check;
alter table public.order_price_history add constraint order_price_history_kind_check
  check (kind in ('set', 'correction', 'raise', 'discount'));

alter table public.order_price_history drop constraint order_price_history_shape;
alter table public.order_price_history add constraint order_price_history_shape check (
  case kind
    when 'set' then previous_total is null
    when 'correction' then previous_total is not null and new_total <> previous_total and reason is not null
    when 'raise' then previous_total is not null and new_total > previous_total and reason is not null
    when 'discount' then previous_total is not null and new_total < previous_total and reason is not null
  end
);

-- 2) Delivery locks nothing; the books do ----------------------------------------
create or replace function public.orders_guard_price_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  collected numeric(12, 2);
begin
  if new.production_status = 'delivered' and new.total_amount is null then
    raise exception 'Set the order total before it can be delivered'
      using errcode = 'check_violation', constraint = 'orders_deliver_requires_price';
  end if;

  if new.total_amount is distinct from old.total_amount then
    if new.total_amount is null then
      raise exception 'A price can''t be removed once set'
        using errcode = 'check_violation', constraint = 'orders_price_not_removable';
    end if;
    select coalesce(sum(p.amount), 0) into collected from public.payments p where p.order_id = new.id;
    if new.total_amount < collected then
      raise exception 'The total (%) can''t be below what''s been collected (%)', new.total_amount, collected
        using errcode = 'check_violation', constraint = 'orders_total_covers_collected';
    end if;
  end if;

  return new;
end;
$$;

-- An order's booking month, closed: no booking into it, no moving out of it, no
-- price change on it. Same per-month lock as payments (4203; a close holds it
-- exclusively), so a close and these can't cross.
create or replace function public.orders_closed_month_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m date;
begin
  if tg_op = 'UPDATE'
     and new.booking_date is not distinct from old.booking_date
     and new.total_amount is not distinct from old.total_amount then
    return new;
  end if;
  for m in
    select distinct date_trunc('month', d)::date
    from unnest(array[case when tg_op = 'UPDATE' then old.booking_date end, new.booking_date]) as d
    where d is not null
    order by 1
  loop
    perform pg_advisory_xact_lock_shared(4203, public.ledger_month_key(m));
    if public.ledger_month_closed(m) then
      raise exception 'The books for % are closed -- orders booked in it can''t be added, moved or repriced', to_char(m, 'FMMonth YYYY')
        using errcode = 'check_violation', constraint = 'orders_booking_month_closed';
    end if;
  end loop;
  return new;
end;
$$;

create trigger orders_closed_month_guard
  before insert or update of booking_date, total_amount on public.orders
  for each row execute function public.orders_closed_month_guard();

revoke execute on function public.orders_closed_month_guard() from public, anon, authenticated, service_role;

-- Payments: the delivered lock goes; the rest stays.
create or replace function public.payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  o record;
  others numeric(12, 2);
begin
  select total_amount into o
    from public.orders where id = coalesce(new.order_id, old.order_id);

  if tg_op in ('INSERT', 'UPDATE') then
    if o.total_amount is null then
      raise exception 'Set the order total before recording a payment'
        using errcode = 'check_violation', constraint = 'payments_need_priced_order';
    end if;
    select coalesce(sum(p.amount), 0) into others
      from public.payments p
      where p.order_id = new.order_id and p.id is distinct from new.id;
    if others + new.amount > o.total_amount then
      raise exception 'Payments (%) would exceed the order total (%)', others + new.amount, o.total_amount
        using errcode = 'check_violation', constraint = 'payments_within_total';
    end if;
    return new;
  end if;

  return old;
end;
$$;

-- 4) The check holds a closed month's orders and total, not just its cash --------
create or replace function public.ledger_reconcile(p_kind text, p_requested_by uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t0 timestamptz := clock_timestamp();
  v_days integer;
  v_mismatched integer;
  v_mismatches jsonb;
  v_overpaid integer;
  v_status_mismatch integer;
  v_closed_drift integer;
  v_closed_details jsonb;
  v_id uuid;
begin
  if not pg_try_advisory_xact_lock(4204, 0) then
    return null;
  end if;

  -- a) Every day: the register against a recount of the receipts.
  with expected as (
    select day, sum(orders)::int as orders, sum(priced)::int as priced, sum(booked) as booked,
           sum(pob) as pob, sum(cash) as cash, sum(payments)::int as payments
    from (
      select o.booking_date as day, count(*) as orders, count(o.total_amount) as priced,
             coalesce(sum(o.total_amount), 0) as booked, 0::numeric as pob, 0::numeric as cash, 0 as payments
      from public.orders o group by 1
      union all
      select o.booking_date, 0, 0, 0, sum(p.amount), 0, 0
      from public.payments p join public.orders o on o.id = p.order_id group by 1
      union all
      select p.paid_at, 0, 0, 0, 0, sum(p.amount), count(*)
      from public.payments p group by 1
    ) x
    group by day
  ),
  cmp as (
    select
      coalesce(e.day, l.day) as day,
      jsonb_strip_nulls(jsonb_build_object(
        'ordersBooked', case when coalesce(e.orders, 0) <> coalesce(l.orders_booked, 0)
          then jsonb_build_object('register', coalesce(l.orders_booked, 0), 'actual', coalesce(e.orders, 0)) end,
        'ordersPriced', case when coalesce(e.priced, 0) <> coalesce(l.orders_priced, 0)
          then jsonb_build_object('register', coalesce(l.orders_priced, 0), 'actual', coalesce(e.priced, 0)) end,
        'total', case when coalesce(e.booked, 0) <> coalesce(l.booked_total, 0)
          then jsonb_build_object('register', coalesce(l.booked_total, 0)::text, 'actual', coalesce(e.booked, 0)::numeric(14, 2)::text) end,
        'paidSoFar', case when coalesce(e.pob, 0) <> coalesce(l.paid_on_booked, 0)
          then jsonb_build_object('register', coalesce(l.paid_on_booked, 0)::text, 'actual', coalesce(e.pob, 0)::numeric(14, 2)::text) end,
        'cashCollected', case when coalesce(e.cash, 0) <> coalesce(l.cash_collected, 0)
          then jsonb_build_object('register', coalesce(l.cash_collected, 0)::text, 'actual', coalesce(e.cash, 0)::numeric(14, 2)::text) end,
        'paymentsCount', case when coalesce(e.payments, 0) <> coalesce(l.payments_count, 0)
          then jsonb_build_object('register', coalesce(l.payments_count, 0), 'actual', coalesce(e.payments, 0)) end
      )) as diff
    from expected e
    full join public.ledger_daily l on l.day = e.day
  )
  select
    count(*)::int,
    count(*) filter (where diff <> '{}'::jsonb)::int,
    coalesce((
      select jsonb_agg(jsonb_build_object('day', c2.day) || c2.diff order by c2.day desc)
      from (select * from cmp where diff <> '{}'::jsonb order by day desc limit 50) c2
    ), '[]'::jsonb)
  into v_days, v_mismatched, v_mismatches
  from cmp;

  -- b) Money rules on every order.
  with paid as (
    select order_id, sum(amount) as paid from public.payments group by order_id
  )
  select
    count(*) filter (where o.total_amount is not null and coalesce(p.paid, 0) > o.total_amount)::int,
    count(*) filter (where o.payment_status <> case
        when o.total_amount is null then 'not_priced'
        when o.total_amount <= 0 then 'fully_paid'
        when coalesce(p.paid, 0) <= 0 then 'unpaid'
        when p.paid >= o.total_amount then 'fully_paid'
        else 'advance_paid'
      end)::int
  into v_overpaid, v_status_mismatch
  from public.orders o
  left join paid p on p.order_id = o.id;

  -- c) Every closed month still holds what it was closed with: its cash and
  --    payments, its booked orders and their total. ("Paid so far" on those
  --    orders still grows as later payments come in -- that's not drift.)
  with latest as (
    select distinct on (c.month) c.*
    from public.ledger_month_closings c
    order by c.month, c.created_at desc, c.id desc
  ),
  now_figures as (
    select l.month,
           coalesce(sum(d.cash_collected), 0) as cash, coalesce(sum(d.payments_count), 0)::int as payments,
           coalesce(sum(d.orders_booked), 0)::int as orders, coalesce(sum(d.booked_total), 0) as booked
    from latest l
    left join public.ledger_daily d on d.day >= l.month and d.day < (l.month + interval '1 month')::date
    where l.action = 'closed'
    group by l.month
  ),
  drift as (
    select l.month, l.cash_collected, l.payments_count, l.orders_booked, l.booked_total,
           n.cash, n.payments, n.orders, n.booked
    from now_figures n
    join latest l on l.month = n.month
    where n.cash <> l.cash_collected or n.payments <> l.payments_count
       or n.orders <> coalesce(l.orders_booked, n.orders) or n.booked <> l.booked_total
  )
  select
    count(*)::int,
    coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(month, 'YYYY-MM'),
      'closedCash', cash_collected::text, 'cashNow', cash::numeric(14, 2)::text,
      'closedPayments', payments_count, 'paymentsNow', payments,
      'closedOrders', orders_booked, 'ordersNow', orders,
      'closedTotal', booked_total::text, 'totalNow', booked::numeric(14, 2)::text
    ) order by month desc), '[]'::jsonb)
  into v_closed_drift, v_closed_details
  from drift;

  insert into public.ledger_reconciliations (
    kind, requested_by, started_at, finished_at, status, days_checked, mismatched_days, mismatches,
    overpaid_orders, status_mismatches, closed_month_drift, details
  ) values (
    p_kind, p_requested_by, t0, clock_timestamp(),
    case when v_mismatched = 0 and v_overpaid = 0 and v_status_mismatch = 0 and v_closed_drift = 0 then 'verified' else 'problems' end,
    v_days, v_mismatched, v_mismatches, v_overpaid, v_status_mismatch, v_closed_drift,
    jsonb_build_object('closedMonths', v_closed_details)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.ledger_reconcile(text, uuid) from public, anon, authenticated, service_role;

-- 5) Indexes for the order-list filters and the phone lookup ------------------------
-- Booking month / year filter: a range on booking_date.
create index if not exists orders_booking_date_idx on public.orders (booking_date);
-- "Fetch customer details": the newest orders for one phone number.
create index if not exists orders_phone_created_idx on public.orders (phone, created_at desc);
