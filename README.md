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

- Express + TypeScript, **Modular Monolith** architecture -- one deployable process, internally partitioned into modules with enforced internal layering (see Architecture below)
- PostgreSQL via Supabase (local: the Supabase CLI's Dockerized stack; prod: a hosted Supabase project) -- this repo owns the schema (`supabase/migrations/`)
- Supabase Auth for identity; this API verifies bearer tokens and enforces RBAC on top
- `src/domain/` -- this repo's **own** copy of the RBAC capability matrix, order-status vocabulary, and the `Profile` type. `needleye-web` keeps an equivalent copy of its own; neither imports from the other or from a shared package. See "No shared package, on purpose" below.

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

This is a **Modular Monolith**: one process, one deployable, internally
split into business-capability modules (`src/modules/*`), each with its own
enforced internal layering (controller → validation → service →
repository). Layers are never merged for convenience -- every module big or
small keeps the same shape, because consistency across the codebase matters
more than trimming a few files for the smaller modules.

```
src/
  index.ts                 # process entry point -- builds the app, calls .listen()
  app.ts                    # composition root: mounts every module's router, nothing else
  config/
    env.ts                   # zod-validated environment config -- the only place env vars are read
  common/                     # cross-cutting infrastructure, used by every module -- NOT a "shared package" (see below), just this repo's own internal plumbing
    errors/app-error.ts          # AppError hierarchy (BadRequestError, ForbiddenError, NotFoundError, ...)
    http/
      async-handler.ts             # wraps async controllers so rejected promises reach the error middleware
      validate.middleware.ts        # validateBody/validateQuery -- the validation layer, parses+replaces req.body/req.query against a zod DTO schema before a controller ever calls a service
    middleware/
      auth.middleware.ts             # requireAuth -- verifies the Supabase JWT, loads the caller's profile
      capability.middleware.ts        # requireCapability -- RBAC gate against the capability matrix
      error.middleware.ts              # the ONLY place a thrown error becomes an HTTP response
    database/supabase-client.ts    # the one Supabase service-role client every repository is built on
    storage/
      storage-provider.ts            # StorageProvider interface -- the one genuine ports/adapters seam in this codebase
      supabase-storage-provider.ts     # the (only) concrete implementation
  domain/                      # shared kernel: core business concepts used by MULTIPLE modules within this repo
    roles.ts, capabilities.ts, order-status.ts, product-categories.ts, profile.ts
    index.ts                     # barrel export
  modules/
    auth/
      auth.routes.ts               # controller -- HTTP only
      auth.service.ts                # business logic (e.g. "refuse bootstrap if an owner already exists")
      auth.repository.ts              # persistence -- the only file that talks to Supabase for this module
      dto/bootstrap.dto.ts             # request DTO (zod schema + inferred type)
    users/
      users.routes.ts, users.service.ts, users.repository.ts, users.mapper.ts
      dto/invite-user.dto.ts, update-user.dto.ts, user.dto.ts
    team-members/
      team-members.routes.ts, team-members.service.ts, team-members.repository.ts, team-members.mapper.ts
      dto/team-member-query.dto.ts, team-member.dto.ts
    orders/                        # the largest module -- every layer earns its keep here
      orders.routes.ts                 # controller
      orders.service.ts                 # business logic: RBAC field-level rules, ownership checks, orchestration
      orders.repository.ts               # persistence: every Supabase query for orders/order_images lives here, behind an OrdersRepository interface
      orders.entity.ts                    # OrderEntity -- the in-memory domain shape, distinct from both the DB row and the API response
      orders.mapper.ts                     # row <-> entity <-> DTO translation (sync); DTO field name -> DB column mapping
      orders.validation.ts                  # image-upload validation (multer files aren't zod/JSON-shaped, so this is separate from validate.middleware.ts)
      dto/create-order.dto.ts, update-order.dto.ts, order.dto.ts
```

### Layer responsibilities (why each one exists, not just what it's called)

- **Controller** (`*.routes.ts`) -- HTTP only: read `req`, call the service, shape `res`. Never touches Supabase, never contains a business rule.
- **Validation** (`common/http/validate.middleware.ts`, applied per-route) -- confirms the request body/query is well-formed against a DTO's zod schema, *before* a controller calls a service. A service can assume its input is already valid; it never re-validates shape.
- **Service** (`*.service.ts`) -- business rules and orchestration only: RBAC field-splitting, ownership checks, "what has to be true for this operation to be allowed." Calls the repository and mapper; never imports the Supabase client directly.
- **Repository** (`*.repository.ts`) -- persistence only, always behind an interface (e.g. `OrdersRepository`) with one concrete Supabase-backed implementation. No business rules -- row-level scoping by role *is* here (it's a data-visibility concern), but *whether the caller is even allowed to attempt the operation* is the service's job.
- **Mapper** (`*.mapper.ts`) -- shape translation only: DB row → domain entity (sync), domain entity → API DTO (async, because resolving signed image URLs is I/O), and DTO → persistence record for writes.
- **Entity** (`orders.entity.ts`) -- the in-memory business object a service actually operates on, deliberately distinct from both the raw DB row (`OrderRow`, snake_case, FK-embedded) and the wire DTO (`OrderDto`, camelCase, with resolved image URLs and computed fields).
- **DTO** (`dto/*.ts`) -- request/response contracts, each a zod schema (for requests, giving validation and a type for free via `z.infer`) or a plain interface (for responses).

### No shared package, on purpose

`needleye-web` and `needleye-api` are separate repos with separate CI/CD and
separate deploys, and **nothing is imported across them** -- the only
connection is HTTP calls against this API's documented endpoints. That
means `src/domain/` (RBAC matrix, order-status vocabulary, the `Profile`
type) is **this repo's own copy** of rules that also exist, independently,
in `needleye-web`'s `lib/domain/`. Neither repo depends on the other, and
there is no third "shared" repo or package either.

**The real tradeoff:** if the RBAC rules or order-status vocabulary change,
both copies need updating by hand -- there's no compiler to catch drift
between them. That's an accepted cost of true service independence for two
apps this size; it stops being fine only if the two copies drift in
practice, at which point the fix is a documented API contract (e.g. an
OpenAPI spec both sides validate against), not a shared code package.

### Error handling

Every layer throws a typed `AppError` subclass (from
`common/errors/app-error.ts`) instead of manually calling
`res.status().json()`. `common/middleware/error.middleware.ts` is the single
place that turns any thrown error -- an `AppError`, a zod `ValidationError`,
a Postgrest/Supabase error, or anything unexpected -- into a consistent
`{ error, code, details? }` JSON response, logging only real 5xx failures
server-side. `asyncHandler` wraps every async controller/middleware so a
rejected promise reaches that middleware instead of crashing the process
(Express 4 doesn't catch async errors on its own).

### RBAC

`profiles.role` (not client-writable JWT metadata) is the authorization
source of truth. `requireCapability('orders:read')` etc. gate access at the
controller layer against the capability matrix in `domain/capabilities.ts`;
`orders.service.ts`'s `updateOrder` additionally splits editable fields into
customer/product vs pricing/assignment groups and checks each
independently, so e.g. a Designer can edit their own order's notes but is
rejected touching `totalAmount`. Row-level scoping (a Designer/Master
Tailor only ever sees their own assigned orders) is applied inside
`orders.repository.ts`'s query construction.

### Dependency injection

No DI container/framework -- manual constructor injection, composed at the
bottom of each module's `*.routes.ts` file (its "composition root"):
`new OrdersService(new SupabaseOrdersRepository(), new OrdersMapper(storageProvider), storageProvider)`.
Every service depends on an interface (`OrdersRepository`, `StorageProvider`),
not a concrete class, so a test could substitute a fake without touching
the service's code -- the wiring is just simple enough not to need a
framework to manage it at this project's size.

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
