-- Closing the books and the nightly check (ADR 0008, phase 5).
--
-- 1. ledger_month_closings -- every close and reopen of a month, append-only.
--    A close stores the month's figures at that moment (the "closing record");
--    a reopen (Owner only, in the API) stores its reason. A month is closed
--    when its latest row says 'closed'.
-- 2. Payments dated in a closed month can't be added, edited or deleted --
--    enforced here as well as in the API. Closing and paying take the same
--    per-month advisory lock (4203; exclusive to close, shared to pay), so a
--    payment can't slip into a month in the moment it's being closed.
-- 3. ledger_reconcile() -- recounts every day from the raw orders and
--    payments and compares with ledger_daily, plus a few money rules, and
--    stores the result in ledger_reconciliations. It never changes figures.
-- 4. pg_cron runs it every night at 02:00 IST (20:30 UTC).

-- 1) Closings -----------------------------------------------------------------
create table public.ledger_month_closings (
  id uuid primary key default gen_random_uuid(),
  -- First day of the month.
  month date not null check (extract(day from month) = 1),
  action text not null check (action in ('closed', 'reopened')),
  -- The month's figures at closing (closed only).
  orders_booked integer,
  orders_priced integer,
  booked_total numeric(14, 2),
  paid_on_booked numeric(14, 2),
  cash_collected numeric(14, 2),
  payments_count integer,
  -- Why it was reopened (reopened only).
  reason text check (reason is null or char_length(reason) between 3 and 500),
  actor_id uuid references public.profiles (id) on delete set null,
  request_id text,
  created_at timestamptz not null default now(),
  constraint ledger_month_closings_shape check (
    case action
      when 'closed' then cash_collected is not null and payments_count is not null and booked_total is not null
      else reason is not null
    end
  )
);

create index ledger_month_closings_month_idx on public.ledger_month_closings (month, created_at desc);

grant select, insert on public.ledger_month_closings to service_role;
alter table public.ledger_month_closings enable row level security;

create trigger ledger_month_closings_append_only
  before update or delete on public.ledger_month_closings
  for each row execute function public.append_only_log();

-- The month's lock key: one advisory key per calendar month.
create or replace function public.ledger_month_key(p_day date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select (extract(year from p_day)::int * 12 + extract(month from p_day)::int);
$$;

-- Is the month that holds p_day closed (its latest close/reopen says 'closed')?
create or replace function public.ledger_month_closed(p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.action = 'closed'
    from public.ledger_month_closings c
    where c.month = date_trunc('month', p_day)::date
    order by c.created_at desc, c.id desc
    limit 1
  ), false);
$$;

-- 2) No payment changes in a closed month --------------------------------------
-- Checks the month of the payment's date before the change (edit, delete) and
-- after it (record, edit), each under the month's SHARED lock -- a close holds
-- it exclusively, so the two serialize.
create or replace function public.payments_closed_month_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m date;
begin
  for m in
    select distinct date_trunc('month', d)::date
    from unnest(array[
      case when tg_op in ('UPDATE', 'DELETE') then old.paid_at end,
      case when tg_op in ('INSERT', 'UPDATE') then new.paid_at end
    ]) as d
    where d is not null
    order by 1
  loop
    perform pg_advisory_xact_lock_shared(4203, public.ledger_month_key(m));
    if public.ledger_month_closed(m) then
      raise exception 'The books for % are closed -- payments dated in it can''t be added, edited or removed', to_char(m, 'FMMonth YYYY')
        using errcode = 'check_violation', constraint = 'payments_month_closed';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger payments_closed_month_guard
  before insert or update or delete on public.payments
  for each row execute function public.payments_closed_month_guard();

-- 3) The check ------------------------------------------------------------------
create table public.ledger_reconciliations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('nightly', 'manual')),
  requested_by uuid references public.profiles (id) on delete set null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (status in ('verified', 'problems')),
  days_checked integer not null,
  mismatched_days integer not null,
  -- Up to 50 days that don't match: [{ day, <field>: { register, actual } }].
  mismatches jsonb not null default '[]'::jsonb,
  -- Orders paid more than their total (the database refuses this; should be 0).
  overpaid_orders integer not null,
  -- Orders whose payment status doesn't match their payments.
  status_mismatches integer not null,
  -- Closed months whose cash no longer matches their closing record.
  closed_month_drift integer not null,
  details jsonb not null default '{}'::jsonb
);

create index ledger_reconciliations_started_idx on public.ledger_reconciliations (started_at desc);
create index ledger_reconciliations_kind_idx on public.ledger_reconciliations (kind, started_at desc);

grant select on public.ledger_reconciliations to service_role;
alter table public.ledger_reconciliations enable row level security;

create trigger ledger_reconciliations_append_only
  before update or delete on public.ledger_reconciliations
  for each row execute function public.append_only_log();

-- Recounts everything from the receipts and compares. Read-only except for
-- its own result row; takes no locks writers wait on (plain MVCC reads). One
-- check at a time: the nightly job and "Verify now" share advisory key
-- (4204, 0); a second check started meanwhile returns null without running.
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

  -- c) Every closed month still holds the cash it was closed with.
  with latest as (
    select distinct on (c.month) c.*
    from public.ledger_month_closings c
    order by c.month, c.created_at desc, c.id desc
  ),
  now_figures as (
    select l.month, coalesce(sum(d.cash_collected), 0) as cash, coalesce(sum(d.payments_count), 0)::int as payments
    from latest l
    left join public.ledger_daily d on d.day >= l.month and d.day < (l.month + interval '1 month')::date
    where l.action = 'closed'
    group by l.month
  )
  select
    count(*) filter (where n.cash <> l.cash_collected or n.payments <> l.payments_count)::int,
    coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(l.month, 'YYYY-MM'),
      'closedCash', l.cash_collected::text, 'cashNow', n.cash::numeric(14, 2)::text,
      'closedPayments', l.payments_count, 'paymentsNow', n.payments
    ) order by l.month desc) filter (where n.cash <> l.cash_collected or n.payments <> l.payments_count), '[]'::jsonb)
  into v_closed_drift, v_closed_details
  from now_figures n
  join latest l on l.month = n.month;

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

-- Who may call the ledger functions. Postgres lets PUBLIC execute every new
-- function, and Supabase serves public functions at /rest/v1/rpc/<name> to its
-- anon and authenticated roles -- so the definer functions are locked down
-- explicitly:
--   * ledger_apply (20261011000001) writes the register: only the ledger
--     triggers call it, as its owner. Nobody else, the app included.
--   * ledger_reconcile runs a full recount: the nightly job (as its owner) and
--     the app ("Verify now").
--   * ledger_month_closed: the payments guard (as its owner) and the app.
revoke execute on function public.ledger_apply(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.ledger_reconcile(text, uuid) from public, anon, authenticated, service_role;
revoke execute on function public.ledger_month_closed(date) from public, anon, authenticated, service_role;

-- The app runs a manual check through ledger_reconcile; it can't write the table itself.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'needleye_app') then
    grant select, insert on public.ledger_month_closings to needleye_app;
    revoke update, delete, truncate on public.ledger_month_closings from needleye_app;
    grant select on public.ledger_reconciliations to needleye_app;
    revoke insert, update, delete, truncate on public.ledger_reconciliations from needleye_app;
    revoke execute on function public.ledger_apply(jsonb) from needleye_app;
    grant execute on function public.ledger_reconcile(text, uuid), public.ledger_month_closed(date) to needleye_app;
  end if;
end;
$$;

-- 4) Every night at 02:00 IST = 20:30 UTC (pg_cron runs on UTC). ---------------
create extension if not exists pg_cron;

select cron.schedule('needleye-ledger-reconcile', '30 20 * * *', $$select public.ledger_reconcile('nightly')$$);
