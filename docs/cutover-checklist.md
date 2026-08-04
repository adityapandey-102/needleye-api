# Local → Production Cutover Checklist

The whole point of this app's provider-agnostic design (see README's
"Infrastructure & providers") is that moving from the local Supabase CLI
stack to a hosted Supabase project is **an environment-variable change, not
a code change**. This checklist is what actually proves that claim, step by
step, rather than just asserting it.

Nothing here has been run against a real hosted Supabase project by an
agent -- that requires an account/billing decision that's the user's to
make, not something to provision autonomously. Each step below is written
so a human can execute it directly.

## 0. Before you start

- [ ] Decide on a hosting target for `needleye-api` (Railway/Fly/Render/etc. -- anywhere that runs a long-lived Node process) and one for `needleye-web` (Vercel is the natural fit for Next.js).
- [ ] Create the hosted Supabase project at [supabase.com](https://supabase.com) (or self-hosted Supabase, if that's the direction -- same env vars either way).

## 1. Database: apply the SQL migrations (not Drizzle, for this first cutover)

Every table today -- both the Supabase-specific glue (RLS, the
`handle_new_user()` trigger, storage bucket registration, Data-API grants)
**and** the portable business tables Drizzle now owns per-module -- was
created by `supabase/migrations/*.sql`. Drizzle's own migrations folder
(`drizzle/`) starts empty on purpose (see `drizzle.config.ts`'s comment):
`drizzle-kit generate` is for the *next* schema change after cutover, not a
replay of history. So for the initial cutover:

- [ ] `npx supabase link --project-ref <your-project-ref>` (from `needleye-api/`, where `supabase/` lives).
- [ ] `npx supabase db push` -- applies every file in `supabase/migrations/*.sql` against the hosted project, in order. This alone creates every table, RLS policy, trigger, and the `order-images` storage bucket.
- [ ] In the Supabase dashboard, confirm the `order-images` bucket exists under Storage, and that `profiles`/`orders`/`payments`/`order_status_history`/etc. all exist under Table Editor.
- [ ] From this point forward, schema changes go through Drizzle (`npm run db:generate` then `npm run db:migrate`, both already pointed at `DATABASE_URL`) for the portable tables, and a new `supabase/migrations/*.sql` file (via `npx supabase migration new <name>`) for anything genuinely Supabase-specific (a new RLS policy, another trigger). The split from ADR 0003 continues to apply.

### 1a. Least-privilege runtime database role (recommended)

- [ ] Run `docs/least-privilege-db-role.sql` once against the hosted DB **as an admin/owner connection** (set a real password first -- don't commit it). It creates `needleye_app`: `LOGIN`, not superuser, data access on exactly the business tables, `BYPASSRLS` (required -- the app connects directly to Postgres, see the script's header and the README's "Operational hardening").
- [ ] This is the **runtime** credential; keep it separate from the **migration** credential. Migrations (step 1, and future `supabase migration`/`drizzle-kit migrate` runs) use the Supabase CLI / an owner connection; the running app uses `needleye_app`. `needleye_app` deliberately cannot run DDL.
- [ ] Point the app's `DATABASE_URL` (step 2) at `needleye_app`, not `postgres`. No application code changes -- it only ever knew a connection string.

## 2. `needleye-api` environment variables

Set these on the hosting platform (never commit them) -- see `.env.example`
for the authoritative list and what each one is for:

- [ ] `DATABASE_URL` -- the hosted project's Postgres connection string, pointed at the least-privilege `needleye_app` role from step 1a (Supabase dashboard → Project Settings → Database → Connection string, then swap the role/password). **Use the Session-mode pooler (port 5432 on the `...pooler.supabase.com` host), not the direct DB host and not Transaction mode (6543).** The app holds a small long-lived `pg.Pool` (max 10) per instance and Drizzle issues named prepared statements; Transaction-mode pooling (PgBouncer) doesn't support prepared statements and would break queries, whereas Session mode assigns one real backend per checked-out connection so the pool and prepared statements behave exactly as against a direct connection — no code change, just the URL. Direct connections also work but don't survive many API instances × 10 connections as the boutique scales; the Session pooler is the safe default. Example: `postgres://needleye_app.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
- [ ] `SUPABASE_URL` -- the hosted project's API URL (`https://<ref>.supabase.co`).
- [ ] `SUPABASE_SERVICE_ROLE_KEY` -- from Project Settings → API. Server-only, never exposed to `needleye-web`.
- [ ] `SUPABASE_ANON_KEY` -- from the same page. Also server-only here (only `SupabaseAuthProvider` uses it, for sign-in/refresh/reset/exchange).
- [ ] `STORAGE_BUCKET_NAME` -- `order-images` (matches what the migration created).
- [ ] `CORS_ALLOWED_ORIGIN` -- the exact deployed `needleye-web` origin (e.g. `https://needleye.example.com`). A mismatch here is the single most common cutover bug: the API deploys fine, then every browser request silently fails CORS while curl/Postman work perfectly, because they don't send an `Origin` header.
- [ ] `WEB_APP_URL` -- same origin as above; only used to build the link inside password-reset emails.
- [ ] `API_PORT` -- whatever the hosting platform expects (many inject `PORT` themselves; confirm this one still gets read correctly, or set it to match).
- [ ] `LOG_LEVEL` -- `info` is a reasonable prod default.
- [ ] `SLOW_QUERY_MS` -- optional; queries slower than this (default 250ms) are logged at WARN.
- [ ] `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` -- optional; auth brute-force limits (default 15min / 30 attempts per IP). `app.set("trust proxy", 1)` is enabled in production so the limiter keys on the real client IP -- confirm your platform sets `X-Forwarded-For` (Railway/Render/Fly do).
- [ ] `NODE_ENV=production`.

Deploy `needleye-api`. Confirm `GET /health` responds before continuing.

## 3. Bootstrap the first Owner/Manager

- [ ] `GET /<api-url>/api/v1/auth/bootstrap-status` should show `{"ownerExists": false}` on a brand-new database.
- [ ] `POST /auth/bootstrap` with `{ email, password, fullName }` for the real first Owner/Manager. This endpoint self-disables the moment one `owner_manager` exists (see `domain/bootstrap.rules.ts`), so it can only be used once -- confirm a second call now returns 403.
- [ ] Log in as that account (`POST /auth/login`) and confirm `GET /auth/me` returns the right profile.

## 4. `needleye-web` environment variables

- [ ] `NEXT_PUBLIC_API_BASE_URL` -- the deployed `needleye-api`'s `/api/v1` URL.
- [ ] `NEXT_PUBLIC_WEB_APP_URL` -- `needleye-web`'s own deployed origin (used to build absolute order-QR-code URLs).

Deploy `needleye-web`. Confirm the login page loads and CORS isn't blocking the `/auth/login` call (browser devtools Network tab, not just "it looks broken" -- a CORS failure and a 500 look identical to an end user).

## 5. Smoke test as each role

Not a replacement for `npm run test:rbac` (see below) -- this is the
human-in-the-browser pass, because a few things only show up that way
(signed image URLs actually resolving, the QR code encoding the right
origin, print layout, toasts):

- [ ] Owner/Manager: create a staff account for each of the other 3 roles (`admin/users`), note the generated passwords.
- [ ] Designer: create an order, upload a reference image, confirm the signed URL actually loads (proves `STORAGE_BUCKET_NAME`/service-role key are correct against the *hosted* Storage, not just the DB).
- [ ] Designer: record a payment on their own order; confirm a Master Tailor viewing the same order sees no payment fields at all.
- [ ] Master Tailor: drag a Kanban card between columns; confirm the status history entry appears with the right name.
- [ ] Accountant: confirm the stat cards / payment ledger show real numbers.
- [ ] Any role: log out, confirm a stale/expired token gets a clean redirect to `/login`, not a crash.

## 6. Run the RBAC matrix against the hosted API

```bash
API_BASE_URL=https://<your-api-url>/api/v1 \
SEED_OWNER_EMAIL=<the bootstrap email from step 3> \
SEED_OWNER_PASSWORD=<its password> \
npm run test:rbac
```

`tests/rbac-matrix.mjs` creates its own throwaway staff accounts and one
throwaway order, exercises the core capability matrix (`orders:create`,
`orders:edit:pricing_assignment`, `payments:read`/`payments:manage`,
`orders:status:design_stages`/`production_stages`, `users:manage`, plus
row-scoping and the unauthenticated-request case), and exits non-zero if
anything returns the wrong status code. It talks to the API over plain
HTTP, so it works identically against `localhost:4000` or a hosted URL --
that's the actual "zero code changes" proof for the backend's behavior, not
just its deployability.

## 7. Optional: seed realistic demo data

`npm run seed` (same script used locally) is safe to run again here --
`src/db/seed.ts` looks up staff by email before creating anyone, so it's
idempotent, and it works against whatever `DATABASE_URL`/Supabase
credentials are currently in the environment. Useful for a staging
environment or a client demo; skip it for a real production go-live (you
don't want 40 fake orders in the actual boutique's database).

## Rollback

Nothing here is destructive to local dev: pointing `needleye-api`'s env
vars back at `127.0.0.1:54321`/`54322` (the values already in
`.env.example`) returns to the local Supabase CLI stack exactly as it was,
with all local data intact. The hosted project can be paused or deleted
independently without touching local dev at all.
