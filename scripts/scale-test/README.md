# Scale, performance & security test harness

A **standalone** toolkit (kept out of the CI test suite on purpose) for stress-
testing the app at target scale — **250 users, 2000 orders/month** — without
ever touching the primary database or Supabase Auth.

It works by cloning **only the `public` schema** (structure, no data) into an
isolated throwaway database (`needleye_scaletest`), seeding synthetic volume
there, pointing a test API instance at it, and measuring. The throwaway DB is
dropped at the end. Run it now, and again against a staging DB before / at
production.

## Pieces

| File | What it does |
|---|---|
| `setup.sh` | Creates the isolated DB, clones the `public` schema, seeds synthetic staff + orders + payments + history. |
| `seed.sql` | The set-based synthetic seed (invoked by `setup.sh`). |
| `load-test.mjs` | N concurrent virtual users hammering the read-heavy endpoints (+ optional writes); per-endpoint latency percentiles + error rate. |
| `security-scan.mjs` | Auth, token-tampering, headers, SQL-injection, CORS, error-body hygiene, rate-limiting checks. |
| `teardown.sh` | Drops the throwaway DB. |

Both `setup.sh`/`teardown.sh` refuse any DB name that doesn't contain
`scaletest`, so they can never operate on the primary database.

## Run it (local)

```bash
# 1. Seed an isolated DB with ~1 year of data (25k orders, 250 staff)
ORDERS=25000 USERS=250 bash scripts/scale-test/setup.sh

# 2. Start a test API against the throwaway DB (separate port), e.g. compiled:
npm run build
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54322/needleye_scaletest" \
  API_PORT=4100 DB_POOL_MAX=30 NODE_ENV=production node dist/index.js &

# 3. Load test — 60 concurrent users, 20s, with a write mix
BASE=http://localhost:4100/api/v1 VUS=60 DURATION_MS=20000 MIX_WRITES=1 \
  node scripts/scale-test/load-test.mjs

# 4. Security scan
BASE=http://localhost:4100/api/v1 node scripts/scale-test/security-scan.mjs

# 5. Tear down
kill %1                                   # stop the test API
bash scripts/scale-test/teardown.sh       # drop the throwaway DB
```

## Run it against staging / production (before go-live)

Point the scripts at the deployed API and a **staging** database (never the live
one for the write/seed parts):

```bash
BASE=https://your-api.up.railway.app/api/v1 \
  EMAIL=owner@yourco.com PASSWORD=... \
  VUS=60 MIX_WRITES=0 node scripts/scale-test/load-test.mjs      # read-only against prod is safe
BASE=https://your-api.up.railway.app/api/v1 node scripts/scale-test/security-scan.mjs
```

Use `MIX_WRITES=0` (read-only) against anything with real data. The seed/volume
part (`setup.sh`) is for a throwaway/staging DB only.

## Knobs

- `ORDERS`, `USERS` — synthetic volume (`setup.sh`).
- `VUS`, `DURATION_MS`, `MIX_WRITES` — load profile (`load-test.mjs`).
- `DB_POOL_MAX` — the API's pool size (main concurrency lever; see `.env.example`).
- `RUN_RATELIMIT=0` — skip the rate-limit probe (`security-scan.mjs`).
