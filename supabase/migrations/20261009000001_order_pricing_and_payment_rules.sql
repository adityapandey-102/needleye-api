-- Pricing and payment rules (ADR 0008, phase 2).
--
--   1. An order can exist WITHOUT a price: total_amount becomes nullable (no
--      default), and payment_status gains 'not_priced' -- kept in lock-step by a
--      CHECK (no total <=> not_priced).
--   2. order_price_history: every price set / raise / discount, with the amount
--      before and after, what had been collected, who, and the reason. Written by
--      the API in the same transaction as the price change; append-only.
--   3. payments.order_id: ON DELETE CASCADE -> RESTRICT. Deleting an order can
--      no longer silently delete its money history.
--   4. Database guards under the API's own checks (the API refuses all of these
--      first, with friendly messages; these stop any other write path):
--        - Delivered needs a price;
--        - a delivered order's price is locked;
--        - a price can't be removed, or set below what's been collected;
--        - no payment on an order without a price, and payments never sum past
--          the total;
--        - payments can't be edited or deleted once the order is delivered.
--
-- Additive for existing data: every existing order has a total (so none becomes
-- 'not_priced'), and every existing ledger already satisfies sum <= total.
--
-- !! Deploy note: run right before deploying the matching API. The API it
-- replaces sends totalAmount "0.00" when the form leaves it empty (which this
-- schema still accepts), but its designers can no longer edit or delete
-- payments on delivered orders -- the database refuses those writes.

-- 1) Orders without a price.
alter table public.orders alter column total_amount drop default;
alter table public.orders alter column total_amount drop not null;

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('not_priced', 'unpaid', 'advance_paid', 'fully_paid'));

alter table public.orders add constraint orders_price_status_consistent
  check ((total_amount is null) = (payment_status = 'not_priced'));

-- The "Price not set" list/card: a few rows out of every order, newest first.
create index if not exists orders_not_priced_idx
  on public.orders (created_at desc)
  where payment_status = 'not_priced';

-- 2) Price history.
create table public.order_price_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  kind text not null check (kind in ('set', 'raise', 'discount')),
  previous_total numeric(12, 2) check (previous_total >= 0),
  new_total numeric(12, 2) not null check (new_total >= 0),
  -- What had been collected when the price changed (a discount can't go below it).
  collected numeric(12, 2) not null check (collected >= 0),
  reason text check (reason is null or char_length(reason) between 3 and 500),
  changed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint order_price_history_shape check (
    case kind
      when 'set' then previous_total is null
      when 'raise' then previous_total is not null and new_total > previous_total and reason is not null
      when 'discount' then previous_total is not null and new_total < previous_total and reason is not null
    end
  ),
  constraint order_price_history_covers_collected check (new_total >= collected)
);

create index order_price_history_order_idx on public.order_price_history (order_id, created_at desc);

grant select, insert on public.order_price_history to service_role;
alter table public.order_price_history enable row level security;
-- No policies: API-only (service role / needleye_app bypass RLS), like leads.

-- Append-only. A delete cascading from an order delete (trigger depth > 1) is
-- allowed; the app never deletes orders, and an order with payments can't be.
create or replace function public.order_price_history_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'order_price_history is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger order_price_history_append_only
  before update or delete on public.order_price_history
  for each row execute function public.order_price_history_append_only();

-- The least-privilege runtime role (docs/least-privilege-db-role.sql), when it
-- exists, only ever reads and appends here.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'needleye_app') then
    grant select, insert on public.order_price_history to needleye_app;
    revoke update, delete, truncate on public.order_price_history from needleye_app;
  end if;
end;
$$;

-- 3) Payments outlive nothing silently.
alter table public.payments drop constraint if exists payments_order_id_fkey;
alter table public.payments add constraint payments_order_id_fkey
  foreign key (order_id) references public.orders (id) on delete restrict;

-- 4a) Order price guards.
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
    if old.production_status = 'delivered' then
      raise exception 'The price of a delivered order is locked'
        using errcode = 'check_violation', constraint = 'orders_price_locked_after_delivery';
    end if;
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

drop trigger if exists orders_guard_price_change on public.orders;
create trigger orders_guard_price_change
  before update of total_amount, production_status on public.orders
  for each row
  when (new.total_amount is distinct from old.total_amount
        or new.production_status is distinct from old.production_status)
  execute function public.orders_guard_price_change();

-- 4b) Payment guards.
create or replace function public.payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  o record;
  others numeric(12, 2);
begin
  select total_amount, production_status into o
    from public.orders where id = coalesce(new.order_id, old.order_id);

  if tg_op in ('UPDATE', 'DELETE') and o.production_status = 'delivered' then
    raise exception 'Payments on a delivered order can''t be changed'
      using errcode = 'check_violation', constraint = 'payments_locked_after_delivery';
  end if;

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

drop trigger if exists payments_guard on public.payments;
create trigger payments_guard
  before insert or update or delete on public.payments
  for each row execute function public.payments_guard();
