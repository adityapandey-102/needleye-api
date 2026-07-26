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
- **Provider-agnostic infrastructure**: every repository talks to PostgreSQL through **Drizzle ORM**, never a vendor query builder; every auth operation goes through an `AuthProvider` interface; every file operation goes through a `StorageProvider` interface. Supabase is today's implementation of the database host, the auth provider, and the storage provider -- all three are independently swappable without touching a service, controller, or DTO. See "Infrastructure & providers" below.
- PostgreSQL, connected via a plain `DATABASE_URL` (local: the Supabase CLI's Dockerized stack; prod: wherever you point it -- Supabase, RDS, Neon, self-hosted, doesn't matter to the app). This repo owns the portable business schema (one `infrastructure/*.schema.ts` per module, see Architecture below, + Drizzle migrations); the Supabase-specific glue (RLS, the `auth.users` trigger, storage bucket setup, Data-API grants) stays in `supabase/migrations/*.sql`, run via the Supabase CLI -- two migration tools, one for the portable schema, one for vendor glue, deliberately not mixed.
- Supabase Auth is today's `AuthProvider` implementation, entirely behind this API -- `needleye-web` never talks to Supabase directly, only to this API's `/auth/*` endpoints. See "Authentication" and "Infrastructure & providers" below.
- Stateless REST: every request carries its own bearer token and is independently verified; nothing about a client's session is stored on the server between requests
- Structured logging (`pino`/`pino-http`) -- every request logged with method/path/status/duration, every error logged with full context. See "Logging" below.
- `src/domain/` -- this repo's **own** copy of the RBAC capability matrix, order-status vocabulary, and the `Profile` type. `needleye-web` keeps an equivalent copy of its own; neither imports from the other or from a shared package. See "No shared package, on purpose" below.

## Prerequisites

- Node.js 22+ (`@supabase/supabase-js`'s Realtime client needs native
  `WebSocket`, only available from Node 22 -- on 20 or below the process
  crashes at startup; see the Dockerfile, pinned to `node:22-alpine`)
- Docker Desktop, running (the local Supabase stack is Dockerized)

## Quick start

```bash
npm install
npx supabase start
# ⤷ prints ANON_KEY / SERVICE_ROLE_KEY

cp .env.example .env
# Fill in SUPABASE_URL (default http://127.0.0.1:54321 is already set) and
# SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY from the `supabase start`
# output above. DATABASE_URL's default (127.0.0.1:54322) already matches
# the local stack -- every repository connects through it via Drizzle.

npm run dev
# ⤷ http://localhost:4000, liveness at /health, readiness (DB-checked) at /health/ready, interactive API docs at /api-docs
```

Stop the stack with `npx supabase stop` (data persists); `npx supabase db reset` wipes and re-applies all migrations from `supabase/migrations/`.

Or, once `.env` is filled in, **one command** does the whole local bring-up
(start Postgres/Auth/Storage, apply any pending migrations, seed dev data,
start the backend): `npm run dev:up`.

`npm run lint` (ESLint, flat config in `eslint.config.mjs`, type-aware via
`typescript-eslint`'s `recommendedTypeChecked`), `npm run typecheck`, and
`npm run test:unit` should all be clean before pushing -- lint, typecheck,
unit tests, and a Docker image build all run in CI on every push/PR (see
"Deployment" below), alongside `npm run build`.

Once an Owner/Manager account exists (`POST /auth/bootstrap`, once), a few
more scripts are useful for local development:

- **`npm run seed`** (`src/db/seed.ts`) -- populates ~40 orders spanning every production status, payment state, and due-date bucket, with real multi-step status history, a reconciling payment ledger, and a handful of reference images, plus the 5 designer / 5 master-tailor / 1 accountant staff accounts (the designer/master names are the prototype's own, for continuity). Safe to re-run -- staff are looked up by email first, so a second run reuses the same accounts instead of duplicating them; it never deletes anything.
- **`npm run test:integration`** (`tests/integration/`, Vitest) -- repository↔database, service↔repository, authentication, and API-endpoint coverage against the real local Supabase stack (no mocking). Creates and tears down its own fixtures every run. See `tests/integration/README.md`.
- **`npm run test:rbac`** (`tests/rbac-matrix.mjs`) -- a small, self-contained per-role 200/403 check against the running API: `orders:create`, `orders:edit:pricing_assignment`, `payments:read`/`payments:manage`, `orders:status:design_stages`/`production_stages`, `users:manage`, row-scoping, and the unauthenticated case. Needs `SEED_OWNER_PASSWORD` set to an existing Owner/Manager's password; creates its own throwaway fixtures, so it never depends on `npm run seed` having been run first.

### Docker

`Dockerfile` (multi-stage: `npm run build` in a full `node:22-alpine`, then
only production dependencies + the `dist/` bundle + `openapi.yaml` in the
runtime stage, running as the non-root `node` user) builds this API into a
single deployable image -- `npm run docker:build`. Verified in CI on every
push/PR (build only, not a run -- see "Deployment" below). To actually run
it locally against the Supabase CLI's stack, point `SUPABASE_URL`/
`DATABASE_URL` at `host.docker.internal` instead of `127.0.0.1` (the
container can't reach the host's `localhost`), e.g.:

```bash
docker build -t needleye-api .
docker run --rm -p 4000:4000 --add-host=host.docker.internal:host-gateway \
  -e SUPABASE_URL=http://host.docker.internal:54321 \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:54322/postgres \
  -e SUPABASE_SERVICE_ROLE_KEY=... -e SUPABASE_ANON_KEY=... \
  -e CORS_ALLOWED_ORIGIN=http://localhost:3000 -e WEB_APP_URL=http://localhost:3000 \
  needleye-api
```

## Architecture

This is a **Feature-Based Modular Monolith**: one process, one deployable,
internally split into business-capability modules (`src/modules/*`).

Every module (`payments`, `team-members`, `users`, `auth`, `orders`) is
built to four internal layers, dependencies always pointing inward:

```
api/            controllers, request/response DTOs, presenters (entity -> DTO)
application/    use-case services, repository ports (interfaces)
domain/         entities, pure business-rule functions -- zero framework/persistence knowledge
infrastructure/ concrete Drizzle adapters, this module's own schema.ts, persistence mappers
```

Domain depends on nothing. Application depends on Domain and declares the
ports Infrastructure must satisfy -- never imports Drizzle directly.
Infrastructure depends on Domain and Application's ports. API depends on
Application only, never reaches into a repository or Drizzle directly. See
`docs/adr/0001-feature-based-clean-architecture-per-module.md` for the full
reasoning and `docs/adr/0002-repository-port-implementation-split.md` /
`0003-per-module-schema-ownership.md` for two decisions that came up during
the conversion. Layers are never merged for convenience -- every module
ends up the same shape regardless of size, because consistency across the
codebase matters more than trimming a few files for the smaller modules.

### Module conversion history

All five modules were converted to the layout above, one at a time, smallest
and lowest-risk first (2026-07-23): `payments` (the first, and still the
best template for a module with real domain rules), then `team-members`,
`users`, `auth`, and finally `orders` (the largest, converted last). Each
module was completed and verified live against the running stack before the
next one started -- nothing was ever left half-migrated within a module,
only across modules that hadn't had their turn yet. See the architecture
review this order came from, kept in git history/PR description rather than
duplicated here.

```
src/
  index.ts                 # process entry point -- builds the app, calls .listen()
  app.ts                    # composition root: mounts every module's router, nothing else
  config/
    env.ts                   # zod-validated environment config -- the only place env vars are read
  common/                     # cross-cutting infrastructure, used by every module -- NOT a "shared package" (see below), just this repo's own internal plumbing
    errors/app-error.ts          # AppError hierarchy (BadRequestError, ForbiddenError, NotFoundError, ...)
    crypto/credentials.ts         # generatePassword, generateQrToken, hashToken -- see "Generated credentials" below
    logger/
      logger.ts                     # the one pino instance -- see "Logging" below
      request-logger.middleware.ts   # pino-http, mounted first in app.ts
    http/
      async-handler.ts             # wraps async controllers so rejected promises reach the error middleware
      validate.middleware.ts        # validateBody/validateQuery -- the validation layer, parses+replaces req.body/req.query against a zod DTO schema before a controller ever calls a service
    middleware/
      auth.middleware.ts             # requireAuth -- verifies the bearer token via AuthProvider, loads the caller's profile via Drizzle
      capability.middleware.ts        # requireCapability -- RBAC gate against the capability matrix
      error.middleware.ts              # the ONLY place a thrown error becomes an HTTP response
    auth/                        # the AuthProvider seam -- see "Infrastructure & providers" below
      auth-provider.ts               # AuthProvider interface + AuthSession/NewAuthUser types -- business-shaped, no vendor concepts
      supabase-auth-provider.ts        # the (only) concrete implementation -- the one file (besides supabase-storage-provider.ts) allowed to import the Supabase SDK
    database/
      schema.ts                     # Drizzle schema for the portable business tables -- the source of truth going forward, not hand-written SQL
      drizzle-client.ts               # the one Postgres connection (via DATABASE_URL) every repository queries through
      supabase-client.ts               # the two Supabase SDK clients -- imported ONLY by supabase-auth-provider.ts and supabase-storage-provider.ts, nowhere else
      profiles.ts                     # fetchActiveProfile (Drizzle) -- shared between requireAuth and the Auth module
    storage/
      storage-provider.ts            # StorageProvider interface -- see "Infrastructure & providers" below
      supabase-storage-provider.ts     # the (only) concrete implementation
  docs/openapi.ts               # loads openapi.yaml (repo root) at startup, served at GET /api-docs
  domain/                      # shared kernel: core business concepts used by MULTIPLE modules within this repo
    roles.ts, capabilities.ts, order-status.ts, product-categories.ts, profile.ts
    index.ts                     # barrel export
  modules/
    auth/                           # everything needleye-web needs to never touch Supabase directly -- see "Authentication" below
      api/
        auth.routes.ts                    # controller -- composition root: new AuthService(new DrizzleAuthRepository(authProvider))
        auth-session.presenter.ts           # (AuthTokens, Profile) -> AuthSessionResponseDto
        dto/bootstrap.dto.ts, login.dto.ts, refresh.dto.ts, password-reset-request.dto.ts, password-update.dto.ts, exchange-code.dto.ts, qr-login.dto.ts, auth-session.response.dto.ts
      application/
        auth.service.ts                     # orchestration (revoke-on-deactivated-login, records last_login_at, ...) + the one domain rule
        ports/auth-repository.port.ts         # the interface -- Application depends on this, never on the Drizzle adapter
      domain/
        bootstrap.rules.ts                    # assertNoOwnerManagerExists -- the bootstrap-once invariant, framework-free
      infrastructure/
        drizzle-auth.repository.ts             # implements the port; owns `qr_login_tokens`, reads `profiles` from modules/users/infrastructure/profile.schema.ts (see ADR 0003) + every identity operation via AuthProvider -- never the Supabase SDK directly
        qr-login.schema.ts                       # this module's own Drizzle table def for `qr_login_tokens` -- Users reads/writes it via an Infrastructure-only import
    users/                          # account creation/password/QR administration -- Owner/Manager only, see the Flow Map below
      api/
        users.routes.ts                  # controller -- composition root: new UsersService(new DrizzleUsersRepository(authProvider))
        user.presenter.ts                  # UserAccountEntity -> UserResponseDto
        dto/create-user.dto.ts, update-user.dto.ts, user.response.dto.ts
      application/
        users.service.ts                   # orchestration: calls the domain credential rules + the repository port
        ports/users-repository.port.ts       # the interface -- Application depends on this, never on the Drizzle adapter
      domain/
        user-account.entity.ts               # UserAccountEntity -- pure, no persistence/HTTP shape
        account-credential.rules.ts            # assertPasswordCanBeRegenerated/assertRoleSupportsQrLogin -- framework-free
      infrastructure/
        drizzle-users.repository.ts            # implements the port; owns `profiles`, reads `qr_login_tokens` from modules/auth/infrastructure/qr-login.schema.ts (see ADR 0003)
        profile.schema.ts                        # this module's own Drizzle table def for `profiles` -- every other module reads it via an Infrastructure-only import
        user-account.mapper.ts                     # Drizzle row -> UserAccountEntity
    team-members/                    # designer/master-tailor lookup backing selects and filters -- read-only, all authenticated roles
      api/
        team-members.routes.ts           # controller
        team-member.presenter.ts           # TeamMemberEntity -> TeamMemberResponseDto
        dto/team-member-query.dto.ts, team-member.response.dto.ts
      application/
        team-members.service.ts            # thin orchestration -- no real business rules for this module (see domain/ note below)
        ports/team-members-repository.port.ts
      domain/
        team-member.entity.ts                # TeamMemberEntity -- an intentionally empty domain-rules layer is honest for a pure lookup, not a failure of the pattern
      infrastructure/
        drizzle-team-members.repository.ts     # implements the port; reads `profiles` from modules/users/infrastructure/profile.schema.ts (see ADR 0003) -- no mapper file, the select already projects directly into entity shape
    orders/                        # the largest module -- every layer earns its keep here, converted last
      api/
        orders.routes.ts                 # controller -- composition root: new OrdersService(new DrizzleOrdersRepository(), storageProvider)
        order.presenter.ts                 # (OrderEntity, amountPaid, role, storageProvider) -> OrderResponseDto -- resolves signed image URLs, strips payment fields the caller's role can't see
        order-status-history.presenter.ts    # OrderStatusHistoryEntity -> OrderStatusHistoryResponseDto
        order-stats.presenter.ts               # OrderStatsRaw -> OrderStatsResponseDto -- strips payment-related aggregates the caller's role can't see
        orders.validation.ts                # image-upload validation (multer files aren't zod/JSON-shaped, so this is separate from validate.middleware.ts)
        dto/create-order.dto.ts, update-order.dto.ts, order.response.dto.ts, update-order-status.dto.ts, order-status-history.response.dto.ts, order-stats.response.dto.ts
      application/
        orders.service.ts                  # orchestration: RBAC field-level rules, ownership checks, status transitions, calls the domain rules + the repository port
        ports/orders-repository.port.ts      # the interface (fully camelCase records) -- Application depends on this, never on the Drizzle adapter
      domain/
        order.entity.ts                      # OrderEntity, OrderImageEntity -- pure, no persistence/HTTP shape
        order-status-history.entity.ts         # OrderStatusHistoryEntity -- one row in the status audit trail
        order-edit.rules.ts                    # assertFieldsEditable/assertOwnershipForScopedEdit -- the RBAC field-splitting + ownership invariants, framework-free
        order-ledger.rules.ts                    # assertOrderCanBeMarkedFullyPaid -- the fully_paid <-> ledger-sum invariant seen from the Orders side (a small, deliberate duplicate of Payments' own rule -- Domain layers don't import across modules, see ADR 0003)
        order-status.rules.ts                      # assertCanTransitionStatus -- design-stage vs production-stage RBAC for PATCH /orders/:id/status, see "Order status history & Kanban" below
        order-visibility.rules.ts                    # canViewPaymentFields -- master_tailor's zero payment-visibility rule
      infrastructure/
        drizzle-orders.repository.ts               # implements the port; reads `profiles` (via order.relations.ts) from Users and `payments` from Payments (see ADR 0003)
        order.schema.ts                              # this module's own Drizzle table def for `orders`
        order-image.schema.ts                          # this module's own Drizzle table def for `order_images`
        order-counter.schema.ts                          # this module's own Drizzle table def for `order_counters` (never queried directly -- backs a DB trigger, kept only for migration/schema completeness)
        order-status-history.schema.ts                    # this module's own Drizzle table def for `order_status_history` -- an append-only audit trail
        order.relations.ts                                # ordersRelations/orderImagesRelations -- kept in its own file, separate from order.schema.ts, per this module's explicit file-naming convention
        order.mapper.ts                                     # Drizzle relational-query row -> OrderEntity
        order-status-history.mapper.ts                       # Drizzle row (leftJoin profiles for the changer's name) -> OrderStatusHistoryEntity
    payments/                       # per-order ledger -- mounted at /orders/:orderId/payments, see "Payment ledger" below
                                     # first module converted to api/application/domain/infrastructure -- see "Module conversion history" above; still the best template for a module with real domain rules
      api/
        payments.routes.ts               # controller -- Router({ mergeParams: true }) to read :orderId from the parent path segment
        payment.presenter.ts               # PaymentEntity -> PaymentResponseDto
        dto/create-payment.dto.ts, update-payment.dto.ts, payment.response.dto.ts
      application/
        payments.service.ts                # orchestration: ownership check, calls the domain rule + the repository port
        ports/payments-repository.port.ts   # the interface -- Application depends on this, never on the Drizzle adapter
      domain/
        payment.entity.ts                   # PaymentEntity, OrderLedgerContext -- pure, no persistence/HTTP shape
        payment-ledger.rules.ts               # assertLedgerReconciles/roundCurrency -- the fully_paid <-> ledger-sum invariant, framework-free
      infrastructure/
        drizzle-payments.repository.ts        # implements the port; reads `orders` from Orders' schema and `profiles` from Users' schema (see ADR 0003)
        payments.schema.ts                      # this module's own Drizzle table def for `payments`
        payments.mapper.ts                        # Drizzle row -> PaymentEntity
```

### Layer responsibilities (why each one exists, not just what it's called)

Every module (`payments`, `team-members`, `users`, `auth`, `orders`) is
filed under `api`/`application`/`domain`/`infrastructure` -- "Repository"
below is `application/ports/*.port.ts` (the interface) plus
`infrastructure/drizzle-*.repository.ts` (the implementation).

- **Controller** (`api/*.routes.ts`) -- HTTP only: read `req`, call the service, shape `res`. Never touches Drizzle, Supabase, or any vendor SDK, never contains a business rule. Also the module's composition root -- wires the concrete Infrastructure adapter into the Application service.
- **Validation** (`common/http/validate.middleware.ts`, applied per-route) -- confirms the request body/query is well-formed against a DTO's zod schema, *before* a controller calls a service. A service can assume its input is already valid; it never re-validates shape.
- **Service** (`application/*.service.ts`) -- business rules and orchestration only: RBAC field-splitting, ownership checks, "what has to be true for this operation to be allowed." Calls the repository port and the domain rule functions; never imports Drizzle, a Provider, or any vendor client directly.
- **Repository port** (`application/ports/*.port.ts`) -- what the Application layer needs from persistence, expressed in domain terms (e.g. `OrdersRepositoryPort`). Application depends on this interface only, never on the concrete adapter.
- **Repository implementation** (`infrastructure/drizzle-*.repository.ts`) -- persistence only, one concrete `Drizzle*Repository` per port, built on Drizzle + this module's own `*.schema.ts`. No business rules -- row-level scoping by role *is* here (it's a data-visibility concern), but *whether the caller is even allowed to attempt the operation* is the service's job. Auth and Users additionally hold an `AuthProvider` dependency for identity operations (create/ban/set-password/mint-session) that aren't table queries at all -- see "Infrastructure & providers" below.
- **Mapper** (`infrastructure/*.mapper.ts`) -- one direction only: Drizzle row → domain entity, sync, no business logic.
- **Presenter** (`api/*.presenter.ts`) -- the other direction: domain entity → API response DTO, async where resolving something (e.g. signed image URLs) needs I/O. Kept explicit even where entity and DTO shapes are currently identical, so they can diverge later without leaking into each other.
- **Entity** (`domain/*.entity.ts`) -- the in-memory business object a service actually operates on, deliberately distinct from both the raw Drizzle row (infrastructure-only, allowed to carry ORM quirks like a `Date` instead of a string) and the wire DTO (camelCase, with resolved image URLs and computed fields where relevant).
- **DTO** (`api/dto/*.ts`) -- request/response contracts, each a zod schema (for requests, giving validation and a type for free via `z.infer`) or a plain interface (for responses).

### Infrastructure & providers

This API is built to not become dependent on a specific infrastructure
vendor. Today it runs on Supabase Postgres + Supabase Auth + Supabase
Storage; nothing in `modules/*` knows that. There are three independent
swap points:

**1. Database host.** Every repository queries through Drizzle
(`common/database/drizzle-client.ts`) against a plain `DATABASE_URL`
connection string. Moving from the Supabase-hosted Postgres to RDS/Neon/Cloud
SQL/self-hosted/anywhere else is an env var change and a `pg_dump`/restore --
zero repository code changes, because no repository has ever imported the
Supabase SDK for data access. Every portable business table now lives under
its owning module's `infrastructure/*.schema.ts` (`drizzle.config.ts`'s
`schema` option is one glob covering all of them): `payments.schema.ts`
(`payments`), `profile.schema.ts` (`profiles`), `qr-login.schema.ts`
(`qr_login_tokens`), and Orders' `order.schema.ts`/`order-image.schema.ts`/`order-counter.schema.ts`
(`orders`/`order_images`/`order_counters`). There is no shared schema file
left -- `common/database/schema.ts` shrank to zero and was deleted once the
last module (Orders) converted. What stays genuinely Supabase-specific, in `supabase/migrations/*.sql`,
run via the Supabase CLI, not Drizzle: RLS policies (they call `auth.uid()`,
a Supabase Postgres function), the `handle_new_user()` trigger (fires on
`auth.users`, a schema Supabase Auth owns), the `order-images` storage
bucket registration, and the `anon`/`authenticated`/`service_role` grants
(Supabase's own Data-API roles). Running two migration tools against one
schema would be a real foot-gun, so the split is explicit: Drizzle owns the
business tables, the Supabase CLI owns the vendor glue, and they're never
asked to manage the same DDL. The next schema change (e.g. Phase 4's
`order_status_history` table) is `npm run db:generate` (writes a migration
under `drizzle/` from whatever changed in `schema.ts`) then `npm run
db:migrate` (applies it); `npm run db:studio` opens Drizzle's own DB
browser against `DATABASE_URL` if you want to poke at data directly.

**2. Auth provider.** `common/auth/auth-provider.ts` declares `AuthProvider`
-- named around what the business needs (`signInWithPassword`,
`mintSessionForUser`, `createUser`, `banUser`, `verifyAccessToken`, ...),
never around Supabase's specific API shape. `SupabaseAuthProvider` is the
only implementation today, and the only file (besides
`supabase-storage-provider.ts`) allowed to import `@supabase/supabase-js`.
`requireAuth`, `DrizzleAuthRepository`, and `DrizzleUsersRepository` all
depend on the `AuthProvider` interface, injected at each module's
composition root (`new DrizzleUsersRepository(authProvider)`, mirroring how `OrdersService`
already received `StorageProvider`). Swapping to Clerk/Auth0/Keycloak/Cognito/a
custom JWT scheme means writing one new class satisfying `AuthProvider` --
**with one honest caveat**: `handle_new_user()` (the trigger that creates a
`profiles` row when a new Supabase Auth user is created) is itself
Supabase-specific glue. Moving off Supabase Auth entirely means replacing
that one trigger with whatever the new provider's equivalent is (e.g. a
webhook that calls `DrizzleUsersRepository`'s Drizzle insert directly) -- a
real, but small and clearly-located, piece of work, not a silent "just
change env vars" claim.

**3. Storage provider.** `common/storage/storage-provider.ts`'s
`StorageProvider` interface predates this refactor (it was already the one
deliberate ports-and-adapters seam in the codebase) and needed no changes
here. `SupabaseStorageProvider` is today's implementation; `S3StorageProvider`/
`R2StorageProvider`/etc. would each be one new class, with
`OrdersService` (the only consumer) unchanged.

**Performance, while rebuilding the persistence layer:** every list/lookup
that needs a related row now does it in one round trip, not one query per
result -- `DrizzleOrdersRepository.findMany`/`findById` use Drizzle's
relational query API (`db.query.orders.findMany({ with: { designer,
masterTailor, images } })`, backed by `ordersRelations` in
`order.relations.ts`) to eager-load designer/master-tailor names and
reference images alongside each order;
`DrizzleUsersRepository`'s QR-login-status flag is one `left join`, not a
second round trip; every ledger sum (`sumByOrderId`, `sumPaymentsForOrder(s)`) is
computed with `SUM()`/`GROUP BY` in Postgres, not by fetching every payment
row and adding them up in Node.

Two further list-path optimizations:

- **`GET /orders` is offset-paginated** (`limit` default 20, max 100; `offset`; response is `{ orders, total, limit, offset }`). The list is the one endpoint whose result set grows without bound as orders accumulate, so it's capped rather than returning every order on every load. `DrizzleOrdersRepository.findMany` applies `limit`/`offset`; `countMany` returns the matching total (they share one `listConditions` builder so the page and its count can never disagree).
- **Signed image URLs are resolved in one batched storage call per response**, not one per image. `OrdersService.signImageUrls` collects every image path across the whole page and calls `StorageProvider.getSignedUrls` (Supabase's `createSignedUrls`) once -- previously a list of N orders made up to 4N round trips to Storage. The presenter is now a pure function that reads from the resulting path→url map.

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

Every repository catches persistence failures and re-throws `InternalError`
with the original error passed as `cause` (native ES2022 `Error.cause` --
`AppError`'s constructor accepts and forwards it) rather than discarding it
-- `error.middleware.ts` logs `err.cause` alongside the wrapper on every
5xx, so a DB failure's actual root cause (a constraint violation, a
connection error, whatever) is diagnosable from the logs, not just the
generic "Failed to load orders"-style message. `cause` never appears in
`details` (which can reach the client response) -- it's server-side-only,
same as everything else that goes to `req.log`.

### Logging

`common/logger/logger.ts` exports a single process-wide `pino` instance,
level controlled by `LOG_LEVEL` (default `info`). `common/logger/request-logger.middleware.ts`
wraps it with `pino-http`, mounted first in `app.ts` -- before CORS, before
`express.json()` -- so every request is logged (method, path, status code,
duration, a generated/propagated `x-request-id`) regardless of what happens
downstream. It also attaches `req.log`, a child logger already carrying that
request's id, so any handler/middleware logs with context for free instead
of needing a logger threaded through every function signature.

- **Levels**: 2xx/3xx → `info`, 4xx → `warn`, 5xx or a thrown non-HTTP error → `error`. `common/middleware/error.middleware.ts` uses `req.log.error`/`req.log.warn` (never raw `console.*`) so every error that reaches it is structured and carries the request id.
- **Redaction**: `req.headers.authorization` (and the equivalent on the response) is redacted to `[redacted]` -- a bearer token must never end up in a log line, in dev or prod. Never add a field containing a raw token/password to a log call without redacting it the same way.
- **Format**: pretty-printed + colorized in development (`pino-pretty`, easy to read in a terminal); plain JSON on stdout in production (`NODE_ENV=production`), so it's pipeable into any log aggregator (Datadog, CloudWatch, etc.) without extra parsing config.
- **Startup logging** (`src/index.ts`) uses the same `logger` instance directly, not `req.log` (there's no request yet).

### Operational concerns (health, pool, shutdown)

- **Health probes**: `GET /health` is a shallow **liveness** check (process up? no dependencies touched -- an orchestrator uses it to decide whether to restart the container). `GET /health/ready` is a **readiness** check that runs `select 1` against Postgres and returns `503` if the DB is unreachable, so a load balancer stops routing to an instance whose database is down instead of sending it doomed requests.
- **Connection pool**: `common/database/drizzle-client.ts` configures the `pg` pool explicitly (`max: 10`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`) rather than relying on pg's defaults -- most importantly, a request fails fast after 5s if no connection is free, instead of pg's default of hanging forever.
- **Graceful shutdown**: `src/index.ts` handles `SIGTERM`/`SIGINT` by closing the HTTP server (letting in-flight requests finish), then draining the pool (`db.$client.end()`), then exiting -- with a hard 10s cap so the process always exits. This matters for container redeploys (Docker/Railway/Fly/etc.): without it, a deploy would kill active requests and leak DB connections.

### Security

- **Secure headers**: `helmet()` is mounted first in `app.ts` (before CORS) on every response -- HSTS, `X-Content-Type-Options: nosniff`, frameguard, hidden `X-Powered-By`, etc. Content-Security-Policy is off (`contentSecurityPolicy: false`): this is a pure JSON API with one HTML view of its own (`/api-docs`, Swagger UI, which needs inline style/script a default CSP would block) -- a same-origin CSP for one internal docs page isn't worth the complexity at this app's scale.
- **CSRF**: not applicable, on purpose. The API is stateless and bearer-token-only -- it never reads or sets cookies, and CSRF exploits ambient cookie-based auth. There is nothing here for a CSRF token to protect.
- **SQL injection**: every query goes through Drizzle's query builder (parameterized) or its `sql\`...\`` tagged-template helper used only for typed column expressions, never for interpolating raw user input into a string. No repository builds a query by string concatenation.
- **File uploads**: `orders.validation.ts`'s `validateImageUpload` enforces a `1-4` slot range and an `image/*` MIME type (client-supplied `Content-Type`, not magic-byte sniffed -- a deliberate, proportionate check at this app's scale, not a defense against a determined attacker) plus a 10MB `multer` size limit.
- **Auth/authz**: see "Authentication" and "RBAC" below -- every route is bearer-token-verified (`requireAuth`) and capability-gated (`requireCapability`/field-level checks in the service layer); `profiles.role` is server-side truth, never trusted from the JWT/client.
- **Input validation**: every request body is parsed against a zod schema (`validateBody`) before a controller calls a service; a service can assume its input already matches the DTO shape.

### RBAC

`profiles.role` (not client-writable JWT metadata) is the authorization
source of truth. `requireCapability('orders:read')` etc. gate access at the
controller layer against the capability matrix in `domain/capabilities.ts`;
`orders/domain/order-edit.rules.ts`'s `assertFieldsEditable` additionally
splits editable fields into customer/product vs pricing/assignment groups
and checks each independently, so e.g. a Designer can edit their own
order's notes but is rejected touching `totalAmount`. Row-level scoping (a
Designer/Master Tailor only ever sees their own assigned orders) is applied
inside `drizzle-orders.repository.ts`'s query construction.

Read-side enforcement matters just as much as write-side:
`orders/domain/order-visibility.rules.ts`'s `canViewPaymentFields`, consulted
by `order.presenter.ts`, strips `paymentStatus`/`totalAmount`/`amountPaid`/`outstanding`
from the response entirely (not just nulling them) whenever the caller's
role has `payments:read === false` (`master_tailor`) -- verified live that
the exact same order returns those fields for an Owner/Manager and omits
them entirely for a Master Tailor. This is real enforcement, not just the
frontend hiding a column; a role with no payment visibility never receives
the data in the first place.

### Payment ledger

`orders.payment_status`/`total_amount` are a manual marker and target set on
the order itself (unchanged from earlier phases); the `payments` table
(`modules/payments/`) is the actual multiple-dated-entries ledger.
`amountPaid`/`outstanding` on every `Order` response are always the real
`SUM(payments.amount)` for that order (`DrizzleOrdersRepository.sumPaymentsForOrder`/
`sumPaymentsForOrders`) -- never stored, always derived at read time, exactly
like the original design called for.

**Access**: `payments:read`/`payments:manage` gate `GET`/`POST`/`PATCH`/`DELETE`
on `/orders/:orderId/payments[/:paymentId]` at the router level (`requireCapability`);
a `designer`'s "assigned" scope is additionally checked in
`PaymentsService.loadOrderForAccess` against the order's `designer_id` --
`master_tailor` has no path to this data at all: not the router (403
immediately), not the RLS policy on `payments` (no `master_tailor` branch,
unlike `orders`/`order_images`), and not the `Order` response's payment
fields (stripped, see above).

**The fully_paid consistency rule** (`PaymentsService.assertReconciles` /
the check in `OrdersService.updateOrder`): the ledger's sum must exactly
equal `total_amount` whenever `payment_status` is `fully_paid` -- enforced
in both directions:
- `PATCH /orders/:id` rejects (409) *setting* `paymentStatus` to `fully_paid`
  if the current ledger sum doesn't match (the final `total_amount`, if
  that's also being changed in the same request).
- Every ledger write (`POST`/`PATCH`/`DELETE` on a payment) rejects (409) if
  the order is *currently* `fully_paid` and the write would leave the sum
  not matching. In practice this means: to correct a ledger entry on an
  order already marked fully paid, change `paymentStatus` away from
  `fully_paid` first, make the correction, then mark it fully paid again
  (which re-validates the sum) -- a deliberate, slightly stricter workflow
  in exchange for the invariant never silently drifting.

Currency comparisons round to the cent (`Math.round(amount * 100)`) before
comparing, to avoid JS floating-point noise (`0.1 + 0.2 !== 0.3`) producing
false-positive rejections.

### Order status history & Kanban

`order_status_history` (`modules/orders/infrastructure/order-status-history.schema.ts`)
replaces the prototype's in-object `timeline: []` array with a real,
queryable audit trail -- one row per production-status change, newest first
via `GET /orders/:id/history`. `label` is a frozen snapshot of the status's
human-readable label at the time of the change (not recomputed from the
current vocabulary later), the way an audit trail should behave. An order's
history is never empty: `DrizzleOrdersRepository.create()` writes the first
row (the order's initial `productionStatus`) in the same DB transaction as
the insert; `updateStatus()` writes every subsequent one in the same
transaction as the `orders.production_status` update -- the order and its
history entry can never disagree, even if one write fails.

**Stage-ownership RBAC, not the flat `orders:edit:*` capabilities.**
`PATCH /orders/:id/status` is deliberately *not* gated by a
`requireCapability` middleware call: which capability applies
(`orders:status:design_stages` vs `orders:status:production_stages`) depends
on the *target* status in the request body, which isn't known until it's
parsed, so `OrdersService.updateStatus` delegates the entire authorization
decision to `domain/order-status.rules.ts`'s `assertCanTransitionStatus`
(same pattern `updateOrder` already uses for its field-split check, via
`assertFieldsEditable`). Moving an order into a design-stage status
(`design_pending`/`design_approved`/`fabric_purchased`, see
`DESIGN_STAGE_STATUSES` in `domain/order-status.ts`) requires
`orders:status:design_stages`; moving it into any other (production-stage)
status requires `orders:status:production_stages`. This makes the
design-to-production handoff a real workflow boundary: a Designer can move
an order freely between design stages, but only a Master Tailor (or
Owner/Manager) can be the one who advances it into `cutting`/`stitching`/etc
-- verified live that a Designer's attempt to jump straight to `cutting`
gets a 403, and that a Master Tailor trying to move an order *back* into a
design-stage status also gets one. Both roles' capabilities are `"assigned"`
scoped, so an unassigned Designer/Master Tailor gets a 403 even for a status
change within their own capability's stage.

### Dashboard stats

`GET /orders/stats` (`DrizzleOrdersRepository.getStats`) computes `total`/`active`/`completed`/`pendingPayments`/`collectedRevenue`/`outstandingRevenue`
entirely in Postgres -- one query with `COUNT(*) FILTER (WHERE ...)` for the
order-level counts (`active`/`completed` derived from the same
`COMPLETED_CANONICAL_STAGES`/`CANONICAL_TO_GRANULAR` vocabulary the Kanban
board groups by, not a separate definition), one more joining `payments` for
`collectedRevenue`. Never fetches every order into Node and reduces --
same "aggregate in the database" principle as `sumPaymentsForOrder(s)`.
Row-scoped the same way `GET /orders` is (`rowScopeCondition`), and
payment-related fields are stripped by `order-stats.presenter.ts` for
callers without `payments:read` (master_tailor) -- verified live that a
Master Tailor's response has only `total`/`active`/`completed`, no payment
keys at all, while an Owner/Manager's has all six. Registered before
`GET /orders/:id` in `orders.routes.ts` so Express doesn't match `stats` as
the `:id` param.

### Authentication

`needleye-web` holds **no Supabase SDK at all** -- every auth operation goes
through this API's `modules/auth` endpoints, which are thin, stateless
wrappers around Supabase Auth:

| Endpoint | What it does |
|---|---|
| `POST /auth/login` | email+password → `{ accessToken, refreshToken, expiresAt, profile }` |
| `POST /auth/refresh` | rotates a refresh token for a new pair |
| `POST /auth/logout` | revokes the session server-side (`auth.admin.signOut`) -- not just "forget the token client-side" |
| `POST /auth/password-reset-request` | always 204, whether or not the email matches an account (never leaks existence) |
| `POST /auth/password-update` | requires a bearer token; updates the caller's own password |
| `POST /auth/exchange-code` | exchanges a PKCE `?code=` from an email link for a session, for projects configured that way |
| `POST /auth/qr-login` | Master Tailor QR login -- see "Account creation, passwords, and QR login" below |
| `GET /auth/me` | the caller's profile, from the bearer token |
| `GET /auth/bootstrap-status`, `POST /auth/bootstrap` | one-time first-Owner/Manager setup, self-disabling once an owner exists |

`DrizzleAuthRepository` never touches Supabase directly for any of this --
every one of those operations is a call to `common/auth/auth-provider.ts`'s
`AuthProvider` interface (see "Infrastructure & providers" above).
`SupabaseAuthProvider`, the implementation, internally uses two Supabase
clients (service-role for admin operations -- create user, ban,
force-set a password; anon-key for the same privilege level a public client
would have -- sign-in, refresh, password reset, code exchange), both with
`persistSession`/`autoRefreshToken` off: nothing is ever kept between
requests, which is what makes this stateless regardless of which provider
is behind `AuthProvider`. Every response hands tokens back in the JSON body
only -- **this API never sets a cookie**. Session persistence (cookies,
refresh-on-expiry) is entirely `needleye-web`'s concern; see that repo's
README for how it uses these endpoints.

`common/database/profiles.ts` (`fetchActiveProfile`, Drizzle) is the one
piece of persistence logic shared across module boundaries within this
repo -- both `requireAuth` (which every module's routes depend on) and the
Auth module's repository need "load this user's profile, reject if
inactive," so it lives in `common/` rather than being duplicated or pulled
sideways from one module into another.

### Account creation, passwords, and QR login

Registration is not invite-by-email: Owner/Manager creates every account
directly from `/admin/users` (`POST /users`) with a password generated
server-side on the spot, returned once in the response. See the Flow Map's
"Create a team member account" diagram.

- **Password scheme** (`common/crypto/credentials.ts`'s `generatePassword`): first name + `-` + an 8-character random suffix from a 57-symbol alphabet (visually-ambiguous characters like `0`/`O` and `1`/`l`/`I` excluded), e.g. `Aditya-9kQ2Xf7q`. Readable enough to write down or read aloud, with real entropy (~47 bits) so knowing the person's name gives no head start guessing it.
- **Who can regenerate whose password** (`UsersService.generatePassword`): Owner/Manager can always regenerate a `designer` or `master_tailor` account's password. For `owner_manager`/`accountant` accounts, it's only available until `profiles.last_login_at` is set (i.e. before their first real login) -- `AuthService.login` records that timestamp, and only a password-based login counts, not a silent token refresh. After that, they're expected to use `POST /auth/password-reset-request` like everyone self-managing their own account.
- **QR login** (`master_tailor` only): `POST /users/:id/qr-token` generates a high-entropy opaque token, stores only its SHA-256 hash (`qr_login_tokens` -- a table with no `anon`/`authenticated` grant at all, reachable only through this API's service-role client; see the migration comment for why it isn't just a column on `profiles`), and returns the raw token/URL once. Regenerating -- or deactivating the account -- immediately invalidates the previous one. `POST /auth/qr-login` verifies the hash, then mints a real session via Supabase's admin `generateLink` (magic-link type) immediately redeemed server-side via `verifyOtp` -- the link is never emailed, `generateLink` is used purely as an internal "issue a session for this user" primitive. See the Flow Map's QR diagrams.
- **Order QR**: unrelated to login -- needleye-web renders a QR (via `qrcode.react`) on each order's detail page that just links to that order's own (already auth-gated, already role-scoped) URL. Nothing new on this API's side beyond the read-side payment-field stripping below.

### Dependency injection

No DI container/framework -- manual constructor injection, composed at the
top of each module's `api/*.routes.ts` file (its "composition root"):
`new OrdersService(new DrizzleOrdersRepository(), storageProvider)`.
Every service depends on an interface (`OrdersRepositoryPort`, `StorageProvider`),
not a concrete class, so a test could substitute a fake without touching
the service's code -- the wiring is just simple enough not to need a
framework to manage it at this project's size.

## API documentation (Swagger / OpenAPI)

`openapi.yaml` (repo root) is the source-of-truth request/response contract
for every route, hand-authored and versioned alongside the code. Served as
an interactive UI at **`GET /api-docs`** (`swagger-ui-express`, wired in
`app.ts`, loaded once at startup by `src/docs/openapi.ts`). If a route's
request/response shape or auth requirement changes, update `openapi.yaml` in
the same change -- see "Keeping this documentation in sync" below.

## Flow map

These diagrams show *how* a request moves through the layers described
above -- the OpenAPI doc above covers *what* each endpoint accepts/returns.

### Every request, generically

```mermaid
flowchart TD
    Client(["Client (needleye-web)"]) -->|"HTTP + Bearer token"| Router["Controller<br/>*.routes.ts"]
    Router --> Auth{"requireAuth"}
    Auth -->|"401 missing/invalid token"| ErrorMW["error.middleware.ts"]
    Auth --> Cap{"requireCapability(cap)"}
    Cap -->|"403 role lacks it"| ErrorMW
    Cap --> Validate["validateBody / validateQuery"]
    Validate -->|"400 malformed"| ErrorMW
    Validate --> Service["Service<br/>*.service.ts<br/>(business rules, RBAC field-splitting)"]
    Service --> Repository["Repository<br/>*.repository.ts"]
    Repository -->|"Supabase client"| DB[("Postgres / Supabase Auth / Storage")]
    DB --> Repository
    Repository -->|"row"| Mapper["Mapper<br/>*.mapper.ts"]
    Mapper -->|"DTO"| Service
    Service --> Router
    Router -->|"JSON response"| Client
    Service -.->|"throws AppError"| ErrorMW
    Repository -.->|"throws AppError"| ErrorMW
    ErrorMW -->|"{ error, code, details? }"| Client
```

### Login

Note the two-provider split: `DrizzleAuthRepository` never touches Supabase or
Postgres directly -- `AuthProvider` for the identity operation, Drizzle
(via `fetchActiveProfile`) for the profile row. Every other diagram below
that shows `Repo->>SB` is exercising this same split; they're left as
`Repo->>SB` for brevity rather than redrawn, but the actual call always
goes through `AuthProvider` first, same as here.

```mermaid
sequenceDiagram
    participant FE as needleye-web
    participant API as api/auth.routes.ts
    participant Svc as AuthService
    participant Repo as DrizzleAuthRepository
    participant AuthP as AuthProvider
    participant SB as Supabase Auth
    participant DB as Drizzle / Postgres

    FE->>API: POST /auth/login { email, password }
    API->>Svc: login(dto)
    Svc->>Repo: signInWithPassword(email, password)
    Repo->>AuthP: signInWithPassword(email, password)
    AuthP->>SB: auth.signInWithPassword() [anon client]
    SB-->>AuthP: session tokens
    AuthP-->>Repo: AuthSession
    Repo-->>Svc: AuthSession
    Svc->>Repo: getProfile(userId)
    Repo->>DB: fetchActiveProfile(userId)
    DB-->>Repo: profile row (throws if inactive/missing)
    alt profile inactive
        Svc->>Repo: signOut(accessToken)
        Repo->>AuthP: signOut(accessToken)
        Svc-->>API: throws ForbiddenError
    else profile active
        Svc-->>API: AuthSessionResponseDto
        API-->>FE: 200 { accessToken, refreshToken, expiresAt, profile }
        FE->>FE: authApi.login() writes ne_at/ne_rt cookies
    end
```

### Silent refresh (every page load / expired token)

```mermaid
sequenceDiagram
    participant Browser
    participant Proxy as proxy.ts (Edge)
    participant API as needleye-api

    Browser->>Proxy: request (cookies: ne_at, ne_rt)
    Proxy->>Proxy: isExpired(ne_at)?
    alt access token missing/expired
        Proxy->>API: POST /auth/refresh { refreshToken: ne_rt }
        alt refresh succeeds
            API-->>Proxy: 200 new token pair
            Proxy->>Browser: rotates ne_at/ne_rt cookies on the response
        else refresh fails (revoked/expired)
            Proxy-->>Browser: 307 to /login, cookies cleared
        end
    end
    Note over Browser,API: lib/api/client.ts and lib/api/server.ts do the same<br/>check-then-refresh before any individual API call
```

### Bootstrap (first Owner/Manager account)

```mermaid
sequenceDiagram
    participant FE as needleye-web (/register)
    participant API as api/auth.routes.ts
    participant Svc as AuthService
    participant Repo as DrizzleAuthRepository

    FE->>API: GET /auth/bootstrap-status
    API->>Svc: getBootstrapStatus()
    Svc->>Repo: countOwnerManagers()
    Repo-->>Svc: count
    Svc-->>FE: { ownerExists }
    opt ownerExists === false
        FE->>API: POST /auth/bootstrap { email, password, fullName }
        API->>Svc: bootstrap(dto)
        Svc->>Repo: countOwnerManagers() [re-checked -- closes the race]
        alt count > 0
            Svc-->>API: throws ForbiddenError
        else count === 0
            Svc->>Repo: createOwnerManagerUser(dto)
            Repo->>Repo: auth.admin.createUser({ role: owner_manager })
            API-->>FE: 201 { ok: true }
            FE->>API: POST /auth/login (same credentials)
        end
    end
```

### Create a team member account

No email invite -- the account exists, with a real password, the moment
Owner/Manager submits the form.

```mermaid
sequenceDiagram
    participant Owner as needleye-web (logged in)
    participant API as api/users.routes.ts
    participant Svc as UsersService
    participant Repo as DrizzleUsersRepository
    participant Crypto as common/crypto/credentials.ts

    Owner->>API: POST /users { email, fullName, role }
    API->>Svc: createUser(dto)
    Svc->>Crypto: generatePassword(fullName)
    Crypto-->>Svc: "Aditya-9kQ2Xf7q" (name + random suffix)
    Svc->>Repo: createUser(email, fullName, role, password)
    Repo->>Repo: auth.admin.createUser({ password, email_confirm: true, data })
    Note over Repo: handle_new_user() DB trigger creates the profiles<br/>row from the user metadata automatically
    API-->>Owner: 201 { userId, password }
    Note over Owner: password shown once in the UI --<br/>Owner/Manager communicates it to the new hire directly
```

### Regenerate a password

```mermaid
sequenceDiagram
    participant Owner as needleye-web (logged in)
    participant API as api/users.routes.ts
    participant Svc as UsersService
    participant Repo as DrizzleUsersRepository

    Owner->>API: POST /users/:id/generate-password
    API->>Svc: generatePassword(targetId)
    Svc->>Repo: findById(targetId)
    Repo-->>Svc: role, last_login_at
    alt role in {owner_manager, accountant} AND last_login_at is set
        Svc-->>API: throws ForbiddenError (they manage their own password now)
    else designer/master_tailor (always), or owner_manager/accountant before first login
        Svc->>Repo: setPassword(targetId, newPassword)
        API-->>Owner: 201 { password }
    end
```

### Generate a Master Tailor's QR login, then use it

```mermaid
sequenceDiagram
    participant Owner as needleye-web (logged in)
    participant API as needleye-api
    participant Svc as UsersService / AuthService
    participant Repo as DrizzleUsersRepository / DrizzleAuthRepository
    participant SB as Supabase Auth
    participant Master as Master Tailor's phone

    Owner->>API: POST /users/:id/qr-token
    API->>Svc: generateQrToken(targetId)
    Svc->>Repo: findById(targetId)
    alt role !== master_tailor
        Svc-->>Owner: throws BadRequestError
    else role === master_tailor
        Svc->>Repo: setQrToken(targetId, sha256(rawToken))
        API-->>Owner: 201 { token, loginUrl }
        Note over Owner: QR (encoding loginUrl) shown once -- print/display it now
    end

    Master->>API: scans QR -> GET /qr-login?token=... -> POST /auth/qr-login { token }
    API->>Svc: signInWithQrToken(token)
    Svc->>Repo: signInWithQrToken(token)
    Repo->>Repo: look up qr_login_tokens by sha256(token) via Drizzle -> profile (must be active)
    Repo->>Repo: mintSessionForUser(email) [via AuthProvider]
    Repo->>SB: auth.admin.generateLink({ type: magiclink, email })
    Note over Repo,SB: never emailed -- generateLink is used purely as an<br/>internal "mint a session for this user" primitive, wrapped by<br/>AuthProvider.mintSessionForUser so the repository never sees<br/>generateLink/verifyOtp as two separate Supabase-specific steps
    Repo->>SB: auth.verifyOtp({ token_hash, type: magiclink })
    SB-->>Repo: real session
    API-->>Master: 200 { accessToken, refreshToken, profile }
```

### Password reset

```mermaid
sequenceDiagram
    participant FE as needleye-web
    participant API as api/auth.routes.ts
    participant SB as Supabase Auth

    FE->>API: POST /auth/password-reset-request { email }
    API->>SB: auth.resetPasswordForEmail(email, { redirectTo })
    API-->>FE: 204 (always -- never confirms the email exists)
    SB-->>FE: reset email, if the account exists
    FE->>FE: clicks link -> /auth/callback reads tokens from the URL fragment, setSession()
    FE->>API: POST /auth/password-update { newPassword }
    API-->>FE: 204
```

### Record a payment, then mark an order fully paid

```mermaid
sequenceDiagram
    participant User as needleye-web (owner_manager / accountant / assigned designer)
    participant PayAPI as api/payments.routes.ts
    participant PaySvc as PaymentsService
    participant PayRepo as DrizzlePaymentsRepository
    participant OrdAPI as api/orders.routes.ts
    participant OrdSvc as OrdersService
    participant OrdRepo as DrizzleOrdersRepository

    User->>PayAPI: POST /orders/:orderId/payments { amount, method }
    PayAPI->>PaySvc: addPayment(ctx, orderId, dto)
    PaySvc->>PayRepo: findOrderContext(orderId)
    PayRepo-->>PaySvc: { designerId, totalAmount, paymentStatus }
    alt scope is "assigned" and caller isn't the order's designer
        PaySvc-->>PayAPI: throws ForbiddenError
    else access ok
        alt order.paymentStatus === "fully_paid"
            PaySvc->>PayRepo: sumByOrderId(orderId)
            PaySvc->>PaySvc: assertLedgerReconciles(sum + amount, totalAmount)
            Note over PaySvc: 409 if the new sum wouldn't still equal totalAmount
        end
        PaySvc->>PayRepo: create(record)
        PayAPI-->>User: 201 { payment }
    end

    Note over User,OrdSvc: Marking fully_paid runs the same check in reverse
    User->>OrdAPI: PATCH /orders/:id { paymentStatus: "fully_paid" }
    OrdAPI->>OrdSvc: updateOrder(ctx, id, dto)
    OrdSvc->>OrdRepo: sumPaymentsForOrder(orderId)
    Note over OrdRepo: its own independent query against the payments table --<br/>not a call into DrizzlePaymentsRepository. Orders' own<br/>assertOrderCanBeMarkedFullyPaid is a small, deliberate duplicate<br/>of Payments' assertLedgerReconciles (see ADR 0003: Domain layers<br/>don't import across modules, only Infrastructure does)
    OrdSvc->>OrdSvc: reject (409) unless sum === totalAmount
```

### Change an order's status (Kanban drag or detail-page action)

```mermaid
sequenceDiagram
    participant User as needleye-web (owner_manager / assigned designer / assigned master_tailor)
    participant API as api/orders.routes.ts
    participant Svc as OrdersService
    participant Rules as order-status.rules.ts
    participant Repo as DrizzleOrdersRepository
    participant DB as Postgres (transaction)

    User->>API: PATCH /orders/:id/status { status }
    API->>Svc: updateStatus(ctx, id, status)
    Svc->>Repo: findBasicById(id)
    Repo-->>Svc: { designerId, masterTailorId, ... }
    Svc->>Rules: assertCanTransitionStatus(role, status, order, callerId)
    Rules->>Rules: isDesignStage = DESIGN_STAGE_STATUSES.includes(status)
    Rules->>Rules: getCapabilityScope(role, isDesignStage ? "orders:status:design_stages" : "orders:status:production_stages")
    alt role has no access to this stage at all
        Rules-->>Svc: throws ForbiddenError
    else scope is "assigned" and caller isn't the stage's owner (designerId/masterTailorId)
        Rules-->>Svc: throws ForbiddenError
    else allowed
        Svc->>Repo: updateStatus(id, status, callerId)
        Repo->>DB: UPDATE orders SET production_status, updated_by
        Repo->>DB: INSERT INTO order_status_history (status, label, changed_by)
        Note over Repo,DB: one transaction -- order and history row never disagree
        DB-->>Repo: committed
        Repo-->>Svc: OrderEntity
        Svc-->>API: OrderResponseDto
        API-->>User: 200 { order }
    end
```

### Route map -- every endpoint, at a glance

| Method & path | Auth | Capability | Controller | Service method | Repository method |
|---|---|---|---|---|---|
| GET `/auth/me` | bearer | -- | auth.routes.ts | (none -- `req.profile` from middleware) | -- |
| GET `/auth/bootstrap-status` | none | -- | auth.routes.ts | `getBootstrapStatus` | `countOwnerManagers` |
| POST `/auth/bootstrap` | none | -- | auth.routes.ts | `bootstrap` | `countOwnerManagers`, `createOwnerManagerUser` |
| POST `/auth/login` | none | -- | auth.routes.ts | `login` | `signInWithPassword`, `getProfile` |
| POST `/auth/refresh` | none | -- | auth.routes.ts | `refresh` | `refreshSession`, `getProfile` |
| POST `/auth/logout` | bearer | -- | auth.routes.ts | `logout` | `signOut` |
| POST `/auth/password-reset-request` | none | -- | auth.routes.ts | `requestPasswordReset` | `requestPasswordReset` |
| POST `/auth/password-update` | bearer | -- | auth.routes.ts | `updatePassword` | `updatePassword` |
| POST `/auth/exchange-code` | none | -- | auth.routes.ts | `exchangeCode` | `exchangeCodeForSession`, `getProfile` |
| POST `/auth/qr-login` | none | -- | auth.routes.ts | `qrLogin` | `signInWithQrToken` |
| GET `/users` | bearer | `users:manage` | users.routes.ts | `listUsers` | `findAll` |
| POST `/users` | bearer | `users:manage` | users.routes.ts | `createUser` | `createUser` |
| POST `/users/:id/generate-password` | bearer | `users:manage` | users.routes.ts | `generatePassword` | `findById`, `setPassword` |
| POST `/users/:id/qr-token` | bearer | `users:manage` | users.routes.ts | `generateQrToken` | `findById`, `setQrToken` |
| PATCH `/users/:id` | bearer | `users:manage` | users.routes.ts | `updateUser` | `updateProfile` |
| POST `/users/:id/deactivate` | bearer | `users:manage` | users.routes.ts | `deactivateUser` | `updateProfile`, `banAuthUser`, `clearQrToken` |
| GET `/orders` | bearer | `orders:read` | orders.routes.ts | `listOrders` | `findMany` (row-scoped) |
| POST `/orders` | bearer | `orders:create` | orders.routes.ts | `createOrder` | `create` |
| GET `/orders/stats` | bearer | `orders:read` | orders.routes.ts | `getStats` | `getStats` (row-scoped; registered before `/:id`) |
| GET `/orders/:id` | bearer | `orders:read` | orders.routes.ts | `getOrder` | `findById` (row-scoped) |
| PATCH `/orders/:id` | bearer | field-split, see below | orders.routes.ts | `updateOrder` | `findBasicById`, `update` |
| PATCH `/orders/:id/status` | bearer | stage-split, see "Order status history & Kanban" below | orders.routes.ts | `updateStatus` | `findBasicById`, `updateStatus` |
| GET `/orders/:id/history` | bearer | `orders:read` | orders.routes.ts | `getOrderHistory` | `findById` (row-scoped), `listStatusHistory` |
| POST `/orders/:id/images` | bearer | `orders:edit:customer_product_fields` | orders.routes.ts | `uploadOrderImage` | `upsertImage` |
| DELETE `/orders/:id/images/:slot` | bearer | `orders:edit:customer_product_fields` | orders.routes.ts | `deleteOrderImage` | `findImage`, `deleteImage` |
| GET `/orders/:orderId/payments` | bearer | `payments:read` | payments.routes.ts | `listPayments` | `findOrderContext`, `findByOrderId` |
| POST `/orders/:orderId/payments` | bearer | `payments:manage` | payments.routes.ts | `addPayment` | `findOrderContext`, `sumByOrderId`, `create` |
| PATCH `/orders/:orderId/payments/:paymentId` | bearer | `payments:manage` | payments.routes.ts | `updatePayment` | `findOrderContext`, `findById`, `sumByOrderId`, `update` |
| DELETE `/orders/:orderId/payments/:paymentId` | bearer | `payments:manage` | payments.routes.ts | `deletePayment` | `findOrderContext`, `findById`, `sumByOrderId`, `delete` |
| GET `/team-members` | bearer | -- (any authenticated role) | team-members.routes.ts | `listActive` | `findActive` |

`PATCH /orders/:id` isn't gated by a single capability at the router level --
`OrdersService.updateOrder` checks `customer_product_fields` vs
`pricing_assignment` independently per field group, which is why it's "--"
in the table above and explained in prose under RBAC.

## Keeping this documentation in sync

When "update documentation" is the ask, or any change touches a route,
DTO, auth flow, or module boundary, update **all** of these together, not
just the one that's most convenient:

1. **This README** -- directory tree, layer descriptions, the Flow Map's diagrams/table above, env vars.
2. **`openapi.yaml`** -- add/change the path, request/response schema, and description; it's hand-authored, not generated, so nothing catches drift automatically.
3. **needleye-web's README** -- if the change affects how the frontend calls this API (new endpoint, changed contract, new env var).

None of these three are generated from the others -- keeping them aligned is
a manual discipline, the same accepted tradeoff as the "no shared package"
decision above (see that section for why this project favors independent,
manually-synced copies over cross-repo/cross-artifact coupling).

## Environment variables

See `.env.example`. In short: `DATABASE_URL` (the actual seam -- every
repository's Drizzle connection goes through this, so this is genuinely
all that changes if you move Postgres hosts), `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` (server-only, never expose), `SUPABASE_ANON_KEY`
(also server-only here -- needleye-web never sees a Supabase key at all;
these three are only read by `SupabaseAuthProvider`/`SupabaseStorageProvider`),
`STORAGE_BUCKET_NAME`, `API_PORT`, `CORS_ALLOWED_ORIGIN` (must match
wherever needleye-web is running/deployed), `WEB_APP_URL` (used only to
build the link inside password-reset emails), `LOG_LEVEL` (`fatal` `error`
`warn` `info` `debug` `trace`, default `info`).

## Deployment

Independent from needleye-web -- deploy this to whatever Node host you like
(Railway/Fly/Render/etc.), pointed at a hosted Supabase project via the same
env vars used locally, or deploy the Docker image (`Dockerfile`) if the host
prefers a container. `.github/workflows/ci.yml` runs two jobs on every
push/PR:

- **`build`**: install, lint, typecheck, unit tests, `npm run build`, and a
  Docker image build (verification only -- not run, not pushed anywhere).
- **`integration`**: spins up the same local Supabase stack CI uses for
  everything else (via `supabase/setup-cli`, GitHub-hosted runners already
  have Docker), points `.env` at it, and runs `npm run test:integration`.

Add a deploy step once a hosting target is chosen.

See `docs/cutover-checklist.md` for the full step-by-step local→prod cutover
(applying `supabase/migrations/*.sql` against the hosted project, every env
var and why it exists, bootstrapping the first Owner/Manager, and running
`npm run test:rbac` against the deployed API as the actual proof that
moving providers really is an env-var change, not a code change).
