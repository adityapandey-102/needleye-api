#!/usr/bin/env bash
# Stand up an ISOLATED throwaway database seeded with synthetic scale data, so
# the app's real behaviour can be measured at target volume WITHOUT touching the
# primary database or Supabase Auth.
#
# What it does:
#   1. Creates a fresh database (default: needleye_scaletest) -- refuses to touch
#      the primary DB name.
#   2. Stubs auth.users and clones ONLY the public schema from the primary DB
#      (structure only, no data), so every table/constraint/trigger matches prod.
#   3. Seeds synthetic staff + orders + payments + history (seed.sql).
#   4. Prints the DATABASE_URL to point a test API instance at.
#
# Usage:
#   ORDERS=25000 USERS=250 ./setup.sh
#
# Env:
#   CONTAINER   Postgres container name        (default: supabase_db_needleye-pilot)
#   SRC_DB      primary DB to clone SCHEMA from (default: postgres)
#   SCALE_DB    throwaway DB to create          (default: needleye_scaletest)
#   ORDERS      synthetic orders                (default: 25000  ~= 1 year @ 2000/mo)
#   USERS       synthetic staff profiles        (default: 250)
#   OWNER_EMAIL real owner (for login)          (default: owner@needleeye.test)
#   DB_PORT     host port of the throwaway DB   (default: 54322)  -- for the URL only
set -euo pipefail

CONTAINER="${CONTAINER:-supabase_db_needleye-pilot}"
SRC_DB="${SRC_DB:-postgres}"
SCALE_DB="${SCALE_DB:-needleye_scaletest}"
ORDERS="${ORDERS:-25000}"
USERS="${USERS:-250}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@needleeye.test}"
DB_PORT="${DB_PORT:-54322}"

# --- Safety: never operate on a primary-looking DB name -----------------------
case "$SCALE_DB" in
  postgres|template0|template1|""|"$SRC_DB")
    echo "REFUSING: SCALE_DB='$SCALE_DB' looks like a primary/system database." >&2
    exit 1 ;;
esac
if [[ "$SCALE_DB" != *scaletest* && "$SCALE_DB" != *scale_test* ]]; then
  echo "REFUSING: SCALE_DB='$SCALE_DB' must contain 'scaletest' as a guard." >&2
  exit 1
fi

psql_src() { docker exec "$CONTAINER" psql -U postgres -d "$SRC_DB" "$@"; }
psql_dst() { docker exec "$CONTAINER" psql -U postgres -d "$SCALE_DB" "$@"; }

OWNER_ID="$(psql_src -t -A -c "select id from public.profiles where email='${OWNER_EMAIL}' limit 1;")"
if [[ -z "$OWNER_ID" ]]; then echo "Owner '${OWNER_EMAIL}' not found in ${SRC_DB}." >&2; exit 1; fi
echo "Owner id: $OWNER_ID"

echo "Dropping + recreating $SCALE_DB ..."
psql_src -c "DROP DATABASE IF EXISTS ${SCALE_DB} WITH (FORCE);" >/dev/null
psql_src -c "CREATE DATABASE ${SCALE_DB};" >/dev/null

echo "Stubbing auth.users + cloning public schema (structure only) ..."
psql_dst -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY); CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS \$\$ SELECT NULL::uuid \$\$;" >/dev/null
# RLS policies referencing auth.* may warn; harmless -- the app connects as a
# superuser that bypasses RLS and enforces authz in the application layer.
docker exec "$CONTAINER" sh -c "pg_dump -U postgres -d ${SRC_DB} --schema-only --schema=public --no-owner --no-privileges" \
  | docker exec -i "$CONTAINER" psql -U postgres -d "$SCALE_DB" -q -o /dev/null 2>/dev/null || true

echo "Seeding synthetic data: ${USERS} staff, ${ORDERS} orders ..."
docker exec -i "$CONTAINER" psql -U postgres -d "$SCALE_DB" -q \
  -v orders="$ORDERS" -v users="$USERS" -v owner_id="$OWNER_ID" \
  < "$(dirname "$0")/seed.sql"

echo ""
echo "Ready. Point a test API instance at this throwaway DB:"
echo "  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${DB_PORT}/${SCALE_DB}"
