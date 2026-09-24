-- Order numbers broke at the 1000th order of a year.
--
-- set_order_number() formatted the sequence with lpad(seq, 3, '0'). Postgres'
-- lpad TRUNCATES text longer than the target length, so seq 1000 became "100",
-- 1001 became "101", ... -- colliding with orders already numbered 100, 101,
-- and every create after the 999th order of the year failed with a unique
-- violation on orders.order_number. (At ~300 orders/month that's around April.)
--
-- Now: at least 3 digits, never fewer than the number has -- ORD-2026-007,
-- ORD-2026-999, ORD-2026-1000, ORD-2026-12345. Existing numbers are unchanged.
create or replace function public.set_order_number()
returns trigger
language plpgsql
as $$
declare
  current_year int := extract(year from now());
  seq int;
begin
  insert into public.order_counters (year, next_seq)
  values (current_year, 2)
  on conflict (year) do update set next_seq = public.order_counters.next_seq + 1
  returning next_seq - 1 into seq;

  new.order_number := 'ORD-' || current_year || '-' || lpad(seq::text, greatest(3, length(seq::text)), '0');
  return new;
end;
$$;
