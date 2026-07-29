-- =============================================================================
-- Least-privilege runtime database role for needleye-api
-- =============================================================================
--
-- WHY: the application should not connect as a superuser. This creates a
-- dedicated role, `needleye_app`, whose only powers are the data operations
-- the app actually performs. A bug or injection then has a contained blast
-- radius -- it can read/write the business tables, but cannot DROP a table,
-- create roles, touch other schemas, or reach Supabase's internal machinery.
--
-- This is a TEMPLATE, run once by an administrator during cutover (see
-- docs/cutover-checklist.md). It is intentionally NOT one of the auto-applied
-- supabase/migrations/*.sql files, because it contains a password and creates
-- a role -- neither belongs in the tracked, auto-run migration history.
--
-- MIGRATIONS vs RUNTIME -- two separate credentials, on purpose:
--   * Migrations (DDL: CREATE TABLE, ALTER, ...) are applied by the Supabase
--     CLI / a privileged owner role. `needleye_app` deliberately CANNOT run them.
--   * The running app connects as `needleye_app` (its DATABASE_URL), which has
--     data access only. Rotating or revoking the app's credential never
--     affects the ability to migrate, and vice versa.
--
-- Run as the database owner/superuser:
--   psql "<admin connection string>" -f docs/least-privilege-db-role.sql
-- (Set a real password first -- do not commit it.)
-- =============================================================================

-- 1) The role. LOGIN so it can connect; explicitly NOT superuser / createdb /
--    createrole. BYPASSRLS is required and intentional: the app connects
--    directly to Postgres (not through PostgREST/GoTrue), so the auth.uid()
--    based RLS policies -- which exist to guard the anon/authenticated Data-API
--    path -- would evaluate auth.uid() as NULL and deny everything. The app is
--    the trusted server that enforces authorization at the application layer
--    (the capability matrix + row scoping in the repositories); it legitimately
--    bypasses RLS, exactly as Supabase's own service_role does. RLS stays on as
--    defense-in-depth for the Data-API path this role never uses.
create role needleye_app with
  login
  password 'CHANGE_ME_BEFORE_RUNNING'
  nosuperuser
  nocreatedb
  nocreaterole
  bypassrls;

-- 2) Connect + see the schema.
grant connect on database postgres to needleye_app;
grant usage on schema public to needleye_app;

-- 3) Data access on exactly the business tables the app uses -- nothing else.
grant select, insert, update, delete on
  public.profiles,
  public.orders,
  public.order_counters,
  public.order_images,
  public.order_status_history,
  public.payments,
  public.qr_login_tokens,
  public.audit_log
to needleye_app;

-- 4) Sequences (future-proofing: none today, since every PK is a uuid default,
--    but any serial column added later needs this) and functions (the
--    order-number BEFORE INSERT trigger calls set_order_number()).
grant usage, select on all sequences in schema public to needleye_app;
grant execute on all functions in schema public to needleye_app;

-- 5) Keep it working as the schema evolves: anything the migration owner
--    creates later automatically grants the same access to needleye_app, so a
--    new table added in a future migration doesn't silently 500 the app.
--    (Run this as the same role that owns/creates the tables -- typically
--    `postgres` on hosted Supabase.)
alter default privileges in schema public
  grant select, insert, update, delete on tables to needleye_app;
alter default privileges in schema public
  grant usage, select on sequences to needleye_app;
alter default privileges in schema public
  grant execute on functions to needleye_app;

-- After this, point the app's DATABASE_URL at needleye_app:
--   postgresql://needleye_app:<password>@<host>:<port>/postgres
-- No application code changes -- the app only ever knew a connection string.
