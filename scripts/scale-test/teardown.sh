#!/usr/bin/env bash
# Drop the throwaway scale-test database. Refuses any non-scaletest name.
set -euo pipefail
CONTAINER="${CONTAINER:-supabase_db_needleye-pilot}"
SRC_DB="${SRC_DB:-postgres}"
SCALE_DB="${SCALE_DB:-needleye_scaletest}"

if [[ "$SCALE_DB" != *scaletest* && "$SCALE_DB" != *scale_test* ]]; then
  echo "REFUSING to drop '$SCALE_DB' (must contain 'scaletest')." >&2
  exit 1
fi
docker exec "$CONTAINER" psql -U postgres -d "$SRC_DB" -c "DROP DATABASE IF EXISTS ${SCALE_DB} WITH (FORCE);"
echo "Dropped ${SCALE_DB}."
