-- Synthetic scale data for the THROWAWAY scale-test database only.
-- Never run against the primary database (setup.sh guards the DB name).
--
-- Params (psql -v):
--   :orders    -- how many orders to generate
--   :users     -- how many staff profiles (split designer/master + a few others)
--   :owner_id  -- the REAL owner's auth id, so owner login works against this DB
--
-- Triggers are disabled during the bulk insert (order_number/updated_at are set
-- explicitly) so 25k+ rows load in a couple of seconds instead of one-by-one.

\set ON_ERROR_STOP on
BEGIN;

-- ---- Staff (auth.users is a stub table in this throwaway DB) --------------
INSERT INTO auth.users (id) SELECT gen_random_uuid() FROM generate_series(1, :users - 1);
INSERT INTO auth.users (id) SELECT :'owner_id'::uuid WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE id = :'owner_id'::uuid);

INSERT INTO profiles (id, full_name, email, role, active, created_at, updated_at)
SELECT
  u.id,
  'Scale User ' || u.rn,
  'scale' || u.rn || '@scaletest.local',
  CASE
    WHEN u.id = :'owner_id'::uuid THEN 'owner_manager'
    WHEN u.rn % 2 = 0 THEN 'designer'
    ELSE 'master_tailor'
  END,
  true, now(), now()
FROM (SELECT id, row_number() OVER () AS rn FROM auth.users) u;

-- Make sure the owner row is owner_manager even if it pre-existed above.
UPDATE profiles SET role = 'owner_manager', full_name = 'Scale Owner' WHERE id = :'owner_id'::uuid;

-- ---- Orders (bulk, triggers off) -----------------------------------------
ALTER TABLE orders DISABLE TRIGGER USER;
ALTER TABLE order_status_history DISABLE TRIGGER USER;
ALTER TABLE payments DISABLE TRIGGER USER;

INSERT INTO orders (
  order_number, customer_name, phone, bill_number, booking_date, due_date,
  designer_id, master_tailor_id, product_category, order_details,
  hand_work, machine_work, purchase_required, payment_status, total_amount,
  production_status, created_by, updated_by, created_at, updated_at, version
)
SELECT
  'ORD-SCALE-' || lpad(g::text, 7, '0'),
  'Customer ' || g,
  '9' || lpad((floor(random() * 1000000000))::bigint::text, 9, '0'),
  'BILL-' || g,
  bd,
  (bd + interval '15 days')::date,
  d.a[1 + floor(random() * array_length(d.a, 1))::int],
  m.a[1 + floor(random() * array_length(m.a, 1))::int],
  (ARRAY['designer_blouse','saree','bridal_lehenga','custom_ethnic_wear','boutique_fashion'])[1 + floor(random() * 5)::int],
  'Synthetic order ' || g,
  random() < 0.3, random() < 0.25, random() < 0.2,
  (ARRAY['unpaid','advance_paid','fully_paid'])[1 + floor(random() * 3)::int],
  round((500 + random() * 49500)::numeric, 2),
  (ARRAY['design_pending','design_approved','production_manager_received','falls_kutchu',
         'fabric_purchased','cutting','stitching','hand_work','machine_work','finishing',
         'quality_check','alteration','delivered'])[1 + floor(random() * 13)::int],
  :'owner_id'::uuid, :'owner_id'::uuid, bd::timestamptz, bd::timestamptz, 0
FROM generate_series(1, :orders) AS g,
     LATERAL (SELECT (now() - (floor(random() * 365) || ' days')::interval)::date AS bd) t,
     (SELECT array_agg(id) a FROM profiles WHERE role = 'designer') d,
     (SELECT array_agg(id) a FROM profiles WHERE role = 'master_tailor') m;

-- One history row per order (its current status).
INSERT INTO order_status_history (order_id, status, label, changed_by, created_at)
SELECT id, production_status, initcap(replace(production_status, '_', ' ')), :'owner_id'::uuid, created_at
FROM orders;

-- A payment on ~70% of orders (<= total, so the overpayment invariant holds).
INSERT INTO payments (order_id, amount, method, paid_at, recorded_by, notes, created_at)
SELECT id,
       round((total_amount * (0.2 + random() * 0.6))::numeric, 2),
       (ARRAY['cash','card','upi','bank_transfer','cheque'])[1 + floor(random() * 5)::int],
       booking_date, :'owner_id'::uuid, NULL, created_at
FROM orders
WHERE random() < 0.7;

ALTER TABLE orders ENABLE TRIGGER USER;
ALTER TABLE order_status_history ENABLE TRIGGER USER;
ALTER TABLE payments ENABLE TRIGGER USER;

COMMIT;

ANALYZE profiles;
ANALYZE orders;
ANALYZE payments;
ANALYZE order_status_history;

SELECT
  (SELECT count(*) FROM profiles)             AS profiles,
  (SELECT count(*) FROM orders)               AS orders,
  (SELECT count(*) FROM payments)             AS payments,
  (SELECT count(*) FROM order_status_history) AS history;
