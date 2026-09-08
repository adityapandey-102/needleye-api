-- Trigram indexes so the orders search (ILIKE '%term%' on customer name / bill
-- number / order number, see drizzle-orders.repository.ts findMany) stays fast
-- as the table grows. Without these, a search for an UNCOMMON term does a
-- sequential scan of the whole orders table (~40ms at 25k rows, and it grows
-- linearly). A GIN trigram index makes the substring match index-backed and
-- roughly volume-independent.
--
-- pg_trgm ships with Postgres/Supabase; CREATE EXTENSION is idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS orders_customer_name_trgm_idx ON public.orders USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_bill_number_trgm_idx   ON public.orders USING gin (bill_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_order_number_trgm_idx  ON public.orders USING gin (order_number gin_trgm_ops);
