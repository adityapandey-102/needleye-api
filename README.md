# Needle Eye API

Express + TypeScript backend for the Needle Eye ERP (a boutique/tailoring
order-management system). Deployed and managed independently from
[needleye-web](https://github.com/REPLACE_ME/needleye-web) (the Next.js
frontend) -- **the two repos share no code and have no dependency on each
other; they only talk over HTTP**, each versioned and deployed on its own
schedule.

> **Maintainers: keep this file current.** Whenever a change touches
> architecture, schema, RBAC, ports, env vars, or the dev workflow, update
> the relevant section here in the same change.

## Stack

- Express + TypeScript, feature-based module structure (see `src/features/`)
- PostgreSQL via Supabase (local: the Supabase CLI's Dockerized stack; prod: a hosted Supabase project) -- this repo owns the schema (`supabase/migrations/`)
- Supabase Auth for identity; this API verifies bearer tokens and enforces RBAC on top
- `src/shared/domain.ts` -- this repo's **own** copy of the RBAC capability matrix, order-status vocabulary, and zod validation. `needleye-web` keeps an equivalent copy of its own; neither imports from the other or from a shared package. See "No shared package, on purpose" below.

## Prerequisites

- Node.js 20+
- Docker Desktop, running (the local Supabase stack is Dockerized)

## Quick start

```bash
npm install
npx supabase start
# ⤷ prints ANON_KEY / SERVICE_ROLE_KEY

cp .env.example .env
# Fill in SUPABASE_URL (default http://127.0.0.1:54321 is already set) and
# SUPABASE_SERVICE_ROLE_KEY from the `supabase start` output above.

npm run dev
# ⤷ http://localhost:4000, health check at /health
```

Stop the stack with `npx supabase stop` (data persists); `npx supabase db reset` wipes and re-applies all migrations from `supabase/migrations/`.

## Architecture

```
src/
  index.ts               # bootstraps the server (listen())
  app.ts                  # Express app construction: middleware, route mounting, error handler
  config/env.ts            # validated environment config
  shared/                   # cross-cutting code, not feature-specific -- internal to this repo only
    domain.ts                 # barrel: RBAC roles/capabilities, order-status vocabulary, zod schemas (this repo's own copy, see below)
    constants/                 # roles, capabilities matrix, order-status/product/payment constants
    types/                       # Profile and other domain types this API returns
    validation/                   # zod schemas (createOrderSchema, inviteUserSchema, ...)
    errors.ts                     # AppError hierarchy (BadRequestError, ForbiddenError, NotFoundError, ...)
    asyncHandler.ts                 # wraps async route handlers so thrown/rejected errors reach the error middleware
    supabaseAdmin.ts                  # service-role Supabase client
    storage/storageProvider.ts          # Supabase Storage abstraction (upload/getSignedUrl/delete)
    middleware/
      auth.ts                              # requireAuth -- verifies JWT, loads profile
      capability.ts                         # requireCapability -- RBAC gate against the capability matrix
      errorHandler.ts                        # the ONLY place that turns a thrown error into an HTTP response
  features/
    auth/auth.routes.ts        # login handoff is client-side (Supabase Auth directly); this covers /me + invite-only bootstrap
    users/users.routes.ts       # owner_manager-only user/role management
    team-members/                # designer/master-tailor lookup used by order assignment
    orders/
      orders.routes.ts             # thin HTTP layer -- parses req, calls the service, sends the response
      orders.service.ts             # business logic + persistence (field-level RBAC enforcement lives here)
      orders.serializer.ts           # DB row -> API response shape
      orders.types.ts                 # DB row types
```

### No shared package, on purpose

`needleye-web` and `needleye-api` are separate repos with separate CI/CD and
separate deploys, and **nothing is imported across them** -- the only
connection is HTTP calls against this API's documented endpoints. That
means `src/shared/domain.ts` (RBAC matrix, order-status vocabulary,
validation schemas) is **this repo's own copy** of rules that also exist,
independently, in `needleye-web`. Neither repo depends on the other, and
there is no third "shared" repo either.

**The real tradeoff:** if the RBAC rules or order-status vocabulary change,
both copies need updating by hand -- there's no compiler to catch drift
between them. That's an accepted cost of true service independence for two
apps this size; it stops being fine only if the two copies drift in
practice, at which point the fix is a documented API contract (e.g. an
OpenAPI spec both sides validate against), not a shared code package.

**Error handling:** every route throws a typed `AppError` subclass (from
`shared/errors.ts`) instead of manually calling `res.status().json()`.
`shared/middleware/errorHandler.ts` is the single place that turns any
thrown error -- an `AppError`, a zod `ValidationError`, a Postgrest/Supabase
error, or anything unexpected -- into a consistent
`{ error, code, details? }` JSON response, logging only real 5xx failures
server-side. `asyncHandler` wraps every async route/middleware so a
rejected promise reaches that middleware instead of crashing the process
(Express 4 doesn't catch async errors on its own).

**RBAC:** `profiles.role` (not client-writable JWT metadata) is the
authorization source of truth. `requireCapability('orders:read')` etc. gate
access against the capability matrix in `shared/domain.ts`;
`PATCH /orders/:id` additionally splits editable fields into
customer/product vs pricing/assignment groups and checks each
independently, so e.g. a Designer can edit their own order's notes but is
rejected touching `totalAmount`.

## Environment variables

See `.env.example`. In short: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(server-only, never expose), `DATABASE_URL`, `STORAGE_BUCKET_NAME`,
`API_PORT`, `CORS_ALLOWED_ORIGIN` (must match wherever needleye-web is
running/deployed).

## Deployment

Independent from needleye-web -- deploy this to whatever Node host you like
(Railway/Fly/Render/etc.), pointed at a hosted Supabase project via the same
env vars used locally. `.github/workflows/ci.yml` runs typecheck + build on
every push/PR; add a deploy step once a hosting target is chosen.
