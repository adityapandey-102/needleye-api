# 0006: Production deployment model — database privileges, connection strategy, and runtime configuration

## Status

Accepted (2026-09-02), at go-live. Records the decisions that only become real
when the app leaves the local Supabase CLI stack. **No application code depends
on any of them** — every item here is an environment or database-administration
choice, which is the point: cutover is a configuration change, not a code change
(see `docs/cutover-checklist.md`).

## Context

The app is a single long-lived Node process (Feature-Based Modular Monolith,
ADR 0001) talking to Postgres directly via Drizzle, plus Supabase for Auth
(GoTrue) and Storage only. Going to production (Railway for the API, Vercel for
the web app, hosted Supabase for database + auth + storage) forces a set of
decisions that local development never surfaces: which database identity the app
runs as, how it pools connections through a managed pooler, and how it learns
the real client IP through a platform proxy.

Each of these has a wrong-but-plausible default that silently breaks something,
so they are recorded here rather than left as folklore.

## Decisions

### 1. The app runs as a least-privilege database role, not as `postgres`

`docs/least-privilege-db-role.sql` provisions **`needleye_app`**: `LOGIN`, and
explicitly **not** superuser / createdb / createrole. It is granted
`SELECT, INSERT, UPDATE, DELETE` on exactly the eight business tables
(`profiles`, `orders`, `order_counters`, `order_images`, `order_status_history`,
`payments`, `qr_login_tokens`, `audit_log`) plus sequence/function usage — and
nothing else.

**Why:** the app never legitimately performs DDL, creates roles, or reads
Supabase's internal schemas. Connecting as a superuser means a bug or an
injection that reaches the database has unlimited blast radius. Running as
`needleye_app`, the worst case is bounded by what the API already exposes: it
cannot `DROP`/`ALTER` a table, cannot create roles, and cannot read the `auth`
schema (where password hashes and identities live).

*Verified:* running the script produces exactly
`rolsuper=f, rolcreatedb=f, rolcreaterole=f, rolcanlogin=t, rolbypassrls=t`,
SELECT/INSERT/UPDATE/DELETE on the eight tables, and **zero** privileges in the
`auth` schema.

*Status:* recommended, not a launch blocker. The app functions identically as
`postgres`; this is defense-in-depth for a database holding customer and payment
records. Rollback is repointing `DATABASE_URL` (and optionally `drop role`).

### 2. Two separate credentials: migration vs runtime

- **Migration credential** — the Supabase CLI / an owner connection. Used only
  when applying `supabase/migrations/*.sql` or `drizzle-kit migrate`.
- **Runtime credential** — `needleye_app`, used by the running app 24/7, and
  deliberately *incapable* of running migrations.

**Why:** rotating or revoking the app's credential never affects the ability to
deploy schema changes, and vice versa. A running app can never corrupt its own
schema. This is why the role script is a **template run once by an
administrator**, not one of the auto-applied migrations — it contains a password
and creates a role, neither of which belongs in tracked migration history.

### 3. `needleye_app` keeps `BYPASSRLS` — deliberately

This looks like a hole and is not. The app connects **directly to Postgres**,
not through PostgREST/GoTrue, so `auth.uid()` evaluates to `NULL` on its
connections. The RLS policies in the schema exist to guard the
`anon`/`authenticated` Data-API path that this app never uses; without
`BYPASSRLS` every query would match zero rows and the app would return empty
results everywhere.

Authorization is enforced in the **application layer** — the capability matrix
(`src/domain/capabilities.ts`), the three status tiers (ADR 0005), and row
scoping inside the repositories. This is precisely the posture Supabase's own
`service_role` takes. RLS stays enabled as defense-in-depth for the path the app
doesn't use.

### 4. Connect through Supabase's **Session-mode** pooler, not Transaction mode

`DATABASE_URL` points at the `...pooler.supabase.com` host on **port 5432**
(Session mode), not port 6543 (Transaction mode) and not the direct database
host.

**Why:** the app holds a small long-lived `pg.Pool` per instance and Drizzle
issues **named prepared statements**. Transaction-mode pooling (PgBouncer)
multiplexes statements across backends and does not support prepared statements
— queries would fail. Session mode assigns one real backend per checked-out
connection, so the pool and prepared statements behave exactly as against a
direct connection. The direct host also works but doesn't scale across
instances; the Session pooler is the safe default.

### 5. `DB_POOL_MAX` is the concurrency lever, and it is environment-configurable

The pool size was previously hard-coded at 10. It is now `DB_POOL_MAX`
(default 10), because the right value is deployment-specific: 10 suits ~20–30
concurrent users, ~20–30 suits 60+, and the ceiling is the database's connection
limit.

*Measured (see `scripts/scale-test/`):* at 250 staff / 25,000 orders, raising the
pool from 10 to 30 changed nothing on a single dev machine — the ceiling there
was CPU contention from running the API and Postgres on the same host, not the
pool. On separated managed infrastructure the pool becomes the relevant lever
again, which is why it is tunable rather than guessed.

### 6. `TRUST_PROXY` must match the number of proxies in front of the app

Express's `trust proxy` was previously `1` whenever `NODE_ENV=production` and
`false` otherwise. That was wrong in both directions: in local development the
Next.js session proxy forwards `X-Forwarded-For` over loopback (making
`express-rate-limit` throw `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`), and hard-coding
`1` assumes exactly one proxy in every production topology.

It is now the `TRUST_PROXY` env var: a hop count (`1` on Railway/Render/Fly),
a preset (`loopback`, the default, correct for local dev), or `false`. **Never
`true`** — that trusts any client-supplied `X-Forwarded-For` and lets a caller
spoof its IP to defeat rate limiting.

### 7. The API listens on `API_PORT`, which platforms must be mapped onto

The server binds `env.API_PORT`. Most platforms inject **`PORT`** instead. On
Railway this means setting `API_PORT=${{PORT}}`. Left unmapped, the platform
health-checks a port nothing is listening on and the deploy looks broken for a
reason that has nothing to do with the app.

*(Kept as `API_PORT` rather than reading `PORT` directly so the variable is
explicit and platform-neutral; the mapping is one line of configuration.)*

### 8. Two Supabase keys, at two privilege levels — both server-only

- **`SUPABASE_ANON_KEY`** → the client used for operations a *public* client
  would perform **on the user's own behalf**: `signInWithPassword`,
  `refreshSession`, `resetPasswordForEmail`, `exchangeCodeForSession`,
  `verifyOtp`. Performing a password grant with the service-role key would be a
  privilege violation.
- **`SUPABASE_SERVICE_ROLE_KEY`** → admin operations the *server* performs:
  `admin.createUser`, ban/unban, `updateUserById` (set password),
  `generateLink` (QR login), token verification, and all Storage signed-URL
  operations.

Neither key is ever sent to the browser — `needleye-web` talks only to this API
and holds no Supabase credentials at all. That is a deliberate property of the
architecture, not an omission.

### 9. Secrets never live in tracked files

`docs/least-privilege-db-role.sql` ships with a `CHANGE_ME_BEFORE_RUNNING`
placeholder. The real password must be supplied at run time and kept in a
password manager / the platform's secret store — **never committed**, since git
history is effectively permanent. `.env` and `.env.local` are gitignored for the
same reason. Prefer running the role script through the Supabase dashboard's SQL
editor, which needs no connection string to be shared at all.

## Consequences

- Cutover remains a configuration exercise: no code branches on environment
  beyond reading these variables.
- Three variables (`TRUST_PROXY`, `API_PORT`, `DATABASE_URL` pooler mode) are
  the realistic causes of a failed first deploy; all three are now called out in
  `.env.example` and the cutover checklist.
- The least-privilege role is optional and reversible, so it can be adopted
  after go-live without redeploying anything but an environment variable.
