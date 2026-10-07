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
npx supabase@2.117.0 start -x imgproxy,edge-runtime,logflare,vector
# ⤷ prints ANON_KEY / SERVICE_ROLE_KEY
# The version is pinned and four unused containers excluded -- see
# "Local stack maintenance" below for why, and how to upgrade.

cp .env.example .env
# Fill in SUPABASE_URL (default http://127.0.0.1:54321 is already set) and
# SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY from the `supabase start`
# output above. DATABASE_URL's default (127.0.0.1:54322) already matches
# the local stack -- every repository connects through it via Drizzle.

npm run dev
# ⤷ http://localhost:4000, liveness at /health, readiness (DB-checked) at /health/ready, interactive API docs at /api-docs
```

Stop the stack with `npx supabase@2.117.0 stop` (data persists); `npx supabase@2.117.0 db reset` wipes and re-applies all migrations from `supabase/migrations/`. **Always include the version** -- see "Local stack maintenance".

Or, once `.env` is filled in, **one command** does the whole local bring-up
(start Postgres/Auth/Storage, apply any pending migrations, seed dev data,
start the backend): `npm run dev:up`.

To start **everything at once -- Supabase + this API + the `needleye-web`
frontend** -- run the repo-root launcher from `needleye-pilot/` (a directory
up): `.\start-dev.ps1` (PowerShell). It starts Supabase, applies migrations,
and opens the API and web dev servers each in their own window; `-Seed`
also seeds demo data, `-Reset` wipes+re-applies the DB first. See the header
comment in `start-dev.ps1` for details.

### Local stack maintenance

**The Supabase CLI version is pinned, everywhere, on purpose.** A bare
`npx supabase` resolves whatever is newest on the registry that day, and each
CLI release pins its *own* Docker image tags (postgres, gotrue, storage-api,
studio, realtime, kong). A newer CLI therefore asks Docker for tags you don't
have, so the whole multi-GB image set is downloaded again and the previous
images are orphaned. Pinning means identical tags every run: Docker reuses
what's on disk and downloads nothing.

The pin lives in **one** place -- `$SupabaseCli` at the top of
`../start-dev.ps1`. The commands in this README quote the same version; keep
them in step when it changes.

Four containers are excluded (`-x imgproxy,edge-runtime,logflare,vector`)
because nothing here uses them: `storage.image_transformation` is off, there
is no `supabase/functions/`, and `[analytics]` is disabled (`vector` only
ships logs to it). Re-enable one in `config.toml` and drop it from the list.
Note the names are *container* names, not config sections -- the analytics
container is `logflare`; passing `analytics` makes the CLI warn and ignore it.
`start -x bogus` prints the valid list.

**Upgrading.** Don't do it on a schedule -- do it when something asks for it:
hosted Supabase changes its Postgres major version (`config.toml`'s
`major_version` must match the remote), you need a CLI feature you don't have,
or you're starting a stretch of backend work after a long gap. "It's been a
while" is not a reason.

`.\start-dev.ps1` checks on each run and *offers* a newer CLI when one exists.
Answer `n` (the default) and nothing changes. Answer `y` and it starts the
stack on the new images, applies migrations, runs `test:unit` + `test:integration`
against it, and rewrites the pin **only if they pass** -- a failure leaves the
pin alone, so the next plain run is back on the known-good version and your old
images are still on disk. `-NoUpdateCheck` skips the check entirely. Run
`npm run test:rbac` afterwards too; it needs the API server up, so the script
can't gate on it.

> **Never `docker system prune -a`.** With `-a` Docker deletes every image not
> used by a *running* container -- do that while the stack is stopped and the
> entire Supabase image set goes, forcing exactly the multi-GB re-download this
> pinning exists to prevent. Plain `docker image prune` (dangling layers only)
> is safe, and is the right way to reclaim images superseded by an upgrade.

`npm run lint` (ESLint, flat config in `eslint.config.mjs`, type-aware via
`typescript-eslint`'s `recommendedTypeChecked`), `npm run typecheck`, and
`npm run test:unit` should all be clean before pushing -- lint, typecheck,
unit tests, and a Docker image build all run in CI on every push/PR (see
"Deployment" below), alongside `npm run build`.

Once an Owner/Manager account exists (`POST /auth/bootstrap`, once), a few
more scripts are useful for local development:

- **`npm run seed`** (`src/db/seed.ts`) -- populates ~40 orders spanning every production status, payment state (unpaid/advance/fully, with the status **derived** from the ledger it records), and due-date bucket, with real multi-step status history and a handful of reference images, plus the 5 designer / 5 master-tailor / 1 accountant staff accounts (the designer/master names are the prototype's own, for continuity). Safe to re-run -- staff are looked up by email first, so a second run reuses the same accounts instead of duplicating them; it never deletes anything.
- **`npm run test:integration`** (`tests/integration/`, Vitest) -- repository↔database, service↔repository, authentication, and API-endpoint coverage against the real local Supabase stack (no mocking). Creates and tears down its own fixtures every run. See `tests/integration/README.md`.
- **`npm run test:rbac`** (`tests/rbac-matrix.mjs`) -- a small, self-contained per-role 200/403 check against the running API: `orders:create`, pricing (`orders:price:set` / `orders:price:adjust` via `PUT /orders/:id/price`), `orders:edit:pricing_assignment`, `payments:read`/`payments:manage`/`payments:correct`, the status tiers (`orders:status:design`/`pm_received`/`production`), `users:manage`, row-scoping, and the unauthenticated case. Needs `SEED_OWNER_PASSWORD` set to an existing Owner/Manager's password; creates its own throwaway fixtures, so it never depends on `npm run seed` having been run first.
- **`npm run test:perf`** (`scripts/perf/query-audit.ts`, local database only) -- the **query audit**. It captures the real SQL of every important repository call, re-runs it with `EXPLAIN ANALYZE` on 3 years of synthetic data (12k orders, 144k stage moves, 360k audit rows) inside a transaction it rolls back, and fails on a query over 150 ms, a large unexpected sequential scan, or an N+1. `--write` refreshes `docs/performance/query-audit.md`. Its fast sibling is the **query budget** (`tests/integration/query-budget.integration.test.ts`, part of `test:integration`): a page of 50 must cost the same number of queries as a page of 5, and page sizes are capped. Rules and reasons are in `docs/engineering-practices.md`; the latest audit is in `docs/performance/README.md`.

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

The remaining ADRs record decisions made after the conversion:
`0004-operational-hardening.md` (request context, error codes, audit,
rate limiting, optimistic locking), `0005-money-roles-status-flow-and-concurrency.md`
(decimal money as strings, the two new roles, the forward-only stage flow --
13 stages then, 14 since Dyeing -- concurrency safety; its 2026-09-24 amendment
adds the finalization tier, the no-skip rule, and the Dyeing stage), and `0006-production-deployment-and-database-privileges.md`
(the least-privilege runtime DB role, migration-vs-runtime credentials, the
Session-mode pooler, `TRUST_PROXY`/`DB_POOL_MAX`/`API_PORT`, and why there are
two Supabase keys). `0007-leads-and-public-enquiry-form.md` records the Leads
module, the public enquiry form and the Ledger Activity export.
`0008-ledger-integrity-pricing-and-stages.md` is the ledger-integrity programme
(five phases): the Marking and Ready stages, Delivered only from Ready, the
pricing and payment rules, split audit logs, ledger totals and closing the books.

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
  docs/openapi.test.ts          # fails if openapi.yaml's ProductCategory / GranularStatus enums drift from the domain lists
  domain/                      # shared kernel: core business concepts used by MULTIPLE modules within this repo
    roles.ts, capabilities.ts, order-status.ts, product-categories.ts (43-category catalogue, 6 collections), profile.ts
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
    reports/                         # owner-only (reports:staff) team view: Working/Idle + the 7-day activity feed -- read-only
      api/
        reports.routes.ts                # controller -- composition root: new ReportsService(new DrizzleReportsRepository(), { timeZone: env.BUSINESS_TIMEZONE })
        dto/reports.dto.ts                 # activity query schema (real date, page <= 100) + response shapes
      application/
        reports.service.ts                 # applies the rules; injectable clock so "today" is testable
        ports/reports-repository.port.ts
      domain/
        staff-activity.rules.ts            # tracked roles, 45/30-day Working windows, shop-timezone "today", the 7-day window, payment.* exclusion
        staff-activity.entity.ts
      infrastructure/
        drizzle-reports.repository.ts      # two raw-SQL reads over profiles / orders / order_status_history / audit_log (see ADR 0003)
    leads/                           # enquiries worked by designers until they become orders (ADR 0007) + the PUBLIC enquiry form
      api/
        leads.routes.ts                  # signed-in: list / summary / badge / detail / add / assign / status / comments (leads:read, leads:manage) -- composition root
        public-enquiries.routes.ts       # NO login: GET /public/enquiry-form + POST /public/enquiries -- own 8 kB body limit (mounted in app.ts) + per-IP and global rate limits
        dto/leads.dto.ts                   # strict zod schemas; names letters-only, phones normalised to 10 digits, text stripped of control chars
      application/
        leads.service.ts                 # who may see/do what (owner = all, designer = own, 404 otherwise); public submit (honeypot, timing token, Turnstile)
        form-token.ts                      # HMAC open-time token: too fast = bot, tampered/expired = reload
        ports/leads-repository.port.ts, ports/human-check.port.ts
      domain/
        lead-status.rules.ts             # the stage machine: who may move a lead from which stage to which; urgent; convertible stages
        enquiry.rules.ts                 # input normalisation + the 2-per-phone-per-24h decision (create / merge / limit) + the customer's wording
        lead.entity.ts
      infrastructure/
        drizzle-leads.repository.ts      # raw SQL; per-phone advisory lock for enquiries; FOR UPDATE on stage changes
        lead-conversion.ts               # converts a lead INSIDE the order-insert transaction (called by the Orders repository)
        cloudflare-turnstile.ts          # siteverify client -- fails closed; wired only when TURNSTILE_ENABLED=true
        leads.schema.ts
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
        order-pricing.rules.ts                   # decidePriceChange (set / raise / discount: who, reason, never below collected, locked once delivered), assertPricedForDelivery, assertEditKeepsTotal (ADR 0008)
        order-ledger.rules.ts                    # derivePaymentStatus -- not_priced/unpaid/advance_paid/fully_paid from the ledger sum, seen from the Orders side (a small, deliberate duplicate of Payments' own copy -- Domain layers don't import across modules, see ADR 0003)
        order-status.rules.ts                      # assertCanChangeStage (four-tier stage RBAC) + assertCanSkipStages (no jumping past a stage the role can't set) for PATCH /orders/:id/status -- forward-only + no-skip enforced under the repository's row lock, see "Order status history & Kanban" below
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
        payment-ledger.rules.ts               # assertDoesNotExceedTotal (overpayment guard), assertOrderPriced, assertPaymentsCorrectable (locked once delivered), assertPaidAtNotFuture + derivePaymentStatus -- framework-free (decimal.js money, see common/money)
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
- **Validation** (`common/http/validate.middleware.ts`, applied per-route) -- confirms the request body/query is well-formed against a DTO's zod schema, _before_ a controller calls a service. A service can assume its input is already valid; it never re-validates shape.
- **Service** (`application/*.service.ts`) -- business rules and orchestration only: RBAC field-splitting, ownership checks, "what has to be true for this operation to be allowed." Calls the repository port and the domain rule functions; never imports Drizzle, a Provider, or any vendor client directly.
- **Repository port** (`application/ports/*.port.ts`) -- what the Application layer needs from persistence, expressed in domain terms (e.g. `OrdersRepositoryPort`). Application depends on this interface only, never on the concrete adapter.
- **Repository implementation** (`infrastructure/drizzle-*.repository.ts`) -- persistence only, one concrete `Drizzle*Repository` per port, built on Drizzle + this module's own `*.schema.ts`. No business rules -- row-level scoping by role _is_ here (it's a data-visibility concern), but _whether the caller is even allowed to attempt the operation_ is the service's job. Auth and Users additionally hold an `AuthProvider` dependency for identity operations (create/ban/set-password/mint-session) that aren't table queries at all -- see "Infrastructure & providers" below.
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
`{ error, code, details?, requestId }` JSON response, and is the **only**
place errors are logged (controllers/services never log-and-rethrow, so an
error is logged exactly once, with method/route/request-id context).
`asyncHandler` wraps every async controller/middleware so a rejected promise
reaches that middleware instead of crashing the process (Express 4 doesn't
catch async errors on its own). Stack traces and the raw `cause` go to the
logs only, never the client (the stack is additionally echoed in the
response body in development, to speed up local debugging).

**Stable error codes.** Every error response carries a `code` from the single
registry in `common/errors/error-codes.ts` (`ORDER_NOT_FOUND`,
`AUTH_INVALID_CREDENTIALS`, `PAYMENT_LEDGER_MISMATCH`, `ORDER_MODIFIED`, ...).
**Clients branch on the code, never on the message** -- messages are free to
change for humans; codes are the contract. Each `AppError` subclass carries
the right HTTP status and a generic default code; throw sites pass a specific
one. Adding an error means adding its code to the registry first, then
referencing it -- never inline a string literal.

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

- **Levels**: 2xx/3xx → `info`, 4xx → `warn`, 5xx or a thrown non-HTTP error → `error`. `common/middleware/error.middleware.ts` uses `req.log.error`/`req.log.warn` (never raw `console.*`) so every error that reaches it is structured and carries the request id. `pino` also supports `trace`/`debug` (developer diagnostics) and `fatal` (unrecoverable/startup) -- selected via `LOG_LEVEL`.
- **Cloud-native, stdout only**: plain JSON on stdout in production (`NODE_ENV=production`); pretty-printed + colorized in development (`pino-pretty`). **No file logging, no rotation, no local log storage** -- the platform (Railway/Render/Fly/etc.) collects stdout. Nothing in the app ever opens a log file.
- **Request context on every line**: a generated (or client-propagated) `x-request-id` is stamped on the response header and on the request/response log, and every authenticated request log also carries `userId`/`role`. An AsyncLocalStorage request context (`common/context/request-context.ts`, populated once by `request-context.middleware.ts` right after the logger, and by `requireAuth`) carries the same request id + user into code that has no `req` -- the audit logger and the slow-query logger -- so **one request id ties together the request log, every app log during that request, slow-query logs, audit records, and the error response**.
- **Slow-query observability**: `common/database/query-timing.ts` wraps the pg pool so any statement over `SLOW_QUERY_MS` (default 250) is logged at `warn` with its duration, the (parameter-free) SQL text, and the correlating request id/user. It only provides visibility -- it never changes or optimizes a query. Parameter _values_ are never logged (they can carry customer data).
- **Database-error tracing**: the same pool wrapper logs **every failed query** at `error` right where it happens -- with the pg SQLSTATE `code`, a readable `label` (e.g. `unique_violation`, `check_violation`, `deadlock_detected`, `connection_refused`), the `constraint`/`table`, the (parameter-free) SQL, and request id/user (`common/database/db-logging.ts` extracts the safe fields). This is deliberate defence against _silent_ DB failures: a database error is traced at the DB layer even if a caller later swallows it or it never reaches the HTTP error middleware. The connection-pool `error` listener, the readiness check, and the 5xx error middleware all log through the same `describeDbError` helper. **It never logs pg's `detail`/`where`** -- those carry the offending row values (PII); the code + constraint + table are enough to diagnose which invariant failed without logging customer data.
- **Redaction**: `authorization` and `cookie` headers (request and response) are redacted to `[redacted]` -- tokens/cookies must never reach a log line, in dev or prod. Never add a field containing a raw token/password to a log call without redacting it the same way.
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
- **Auth rate limiting**: `common/middleware/rate-limit.middleware.ts` (`express-rate-limit`, in-memory) throttles brute-force against the credential/token endpoints -- applied only to `/auth/*` (login, refresh, password reset/update, exchange-code, qr-login), `AUTH_RATE_LIMIT_MAX` attempts per `AUTH_RATE_LIMIT_WINDOW_MS` per IP, returning `429` + `RATE_LIMITED`. In-memory is the right fit for this single-process monolith; the limiter is isolated in that one module so swapping to a shared store later is a one-line `store:` change with nothing else touched (no Redis introduced). `app.set("trust proxy", 1)` in production so it keys on the real client IP behind the hosting proxy.
- **Least-privilege database role**: in production the app should connect as a dedicated, non-superuser DB role rather than `postgres`. See "Operational hardening" below and `docs/least-privilege-db-role.sql`.

### Operational hardening (request IDs, audit, optimistic locking, DB role)

- **Request IDs** -- see "Logging" above: one id per request, on the response header, every log line, and the error response body.
- **Audit logging** (`common/audit/`): a business audit trail, separate from the developer-facing application logs. `AuditLogger` is an interface (`audit-logger.ts`); `DrizzleAuditLogger` writes to the `audit_log` table (`supabase/migrations/20260726000001_audit_log.sql`), filling in the actor and request id from the request context. Business services record important actions through it -- login/logout, password change, user create/update/deactivate/password-regen/QR, order create/update/status-change/image-delete, payment create/update/delete (action strings in `audit-actions.ts`). Best-effort by contract: a failed audit write is logged and swallowed, never breaking the business action. To send audit events somewhere else later (an external audit sink), write one new class implementing `AuditLogger` -- no service changes. There's no audit-read endpoint in scope; `audit_log` has no anon/authenticated grant.
- **Optimistic locking on order edits**: `orders.version` (integer, `supabase/migrations/20260726000002_orders_version.sql`) is returned on every order and echoed back by the edit form as `version` in `PATCH /orders/:id`. The repository bumps `version` on every update and, when a version is supplied, guards the write on it (`WHERE id = ? AND version = ?`); a second concurrent edit still holding the old version affects 0 rows and is rejected with `409 ORDER_MODIFIED` -- "someone changed this, reload" -- rather than silently clobbering the first edit. A dedicated integer column (not `updated_at`) avoids timestamp-precision round-tripping between Postgres and JS.
- **Orphaned-file prevention** (`OrdersService`): replacing an image deletes the previous storage object once the DB points at the new one; deleting an image removes the DB row **first**, then the storage object -- so a storage failure can only leave an invisible orphaned object, never a dangling DB row that renders as a broken image. Storage-delete failures are logged, not surfaced, so cleanup never fails an otherwise-successful operation.
- **Least-privilege DB role** (`docs/least-privilege-db-role.sql`): a template (run once by an admin at cutover, not an auto-applied migration -- it holds a password and creates a role) that provisions `needleye_app`: `LOGIN`, **not** superuser/createdb/createrole, with `SELECT/INSERT/UPDATE/DELETE` on exactly the business tables (plus sequence/function grants and default privileges for future tables). It keeps `BYPASSRLS` on purpose -- the app connects directly to Postgres (not via PostgREST), so the `auth.uid()`-based RLS meant for the Data-API path would evaluate to NULL and deny everything; the app is the trusted server enforcing authz at the application layer, exactly as Supabase's own `service_role` does. This separates **runtime** credentials (the app's `DATABASE_URL` → `needleye_app`, data access only, cannot run DDL) from **migration** credentials (the Supabase CLI / an owner role). No application code changes -- the app only ever knew a connection string.

### RBAC

There are **six roles** (`domain/roles.ts`): `owner_manager`, `designer`,
`master_tailor`, `accountant`, `production_manager`, and `worker`. A
**Production Manager** is a designer that can view/edit/search _any_ order (not
just assigned) and owns the "Production Manager Received" stage; a **Worker** is
a shop-floor role like a master tailor for status purposes but with no dashboard
(the web nav is empty; `/orders` redirects to `/scan`) — it only scans an order
QR and views/advances it. See ADR 0005 for the full rationale.

`profiles.role` (not client-writable JWT metadata) is the authorization
source of truth. `requireCapability('orders:read')` etc. gate access at the
controller layer against the capability matrix in `domain/capabilities.ts`;
`orders/domain/order-edit.rules.ts`'s `assertFieldsEditable` additionally
splits editable fields into two groups -- customer/product
(`orders:edit:customer_product_fields`) and designer/master reassignment
(`orders:edit:pricing_assignment`) -- and checks each independently, so e.g.
a Designer can edit their own order's notes but is rejected reassigning its
master tailor. **The total is not an editable field** (ADR 0008): an edit may
resend it unchanged (ignored), any other value is `400 ORDER_PRICE_USE_PRICING`
-- prices change only through `PUT /orders/:id/price` (see "Pricing" below). Row-level scoping (a
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

### Pricing (ADR 0008)

A new order normally has **no price**: `total_amount` is null and
`payment_status` is `not_priced` (a CHECK keeps the two in step). The web asks
"Add pricing now?" right after an order is saved. Every `Order` response
carries `priceSet` for every role (it's not an amount), so any role can tell
that Delivered needs pricing first.

`PUT /orders/:id/price { totalAmount, reason? }` is the only way a total
changes. `OrdersService.changePrice` hands `decidePriceChange`
(`order-pricing.rules.ts`) to `DrizzleOrdersRepository.changePrice`, which
runs it against the order **locked** (`FOR UPDATE` -- a payment locks the same
row, so "collected" can't move underneath) and writes the new total, the
re-derived status and one `order_price_history` row in the same transaction:

| Order now | New total | Kind | Who | Reason |
|---|---|---|---|---|
| no price | any (₹0 = free work) | `set` | owner, accountant, the order's own designer (`orders:price:set`) | optional |
| priced | higher | `raise` | owner, accountant (`orders:price:adjust`) | required |
| priced | lower | `discount` | owner, accountant | required; never below what's collected |

A delivered order's price is locked (`409 ORDER_PRICE_LOCKED`), and
`PATCH /orders/:id/status` refuses Delivered without a price
(`409 ORDER_PRICE_REQUIRED`, "Set the order total first"). A total given at
booking (`POST /orders` with `totalAmount`) is recorded as the first `set`
and needs the same right (the PM gets `403 ORDER_PRICE_FORBIDDEN`).
`GET /orders/:id/price-history` lists the changes (`payments:read` roles, row-scoped).

**The database enforces the same rules underneath** (migration
`20261009000001`): `orders_guard_price_change` (Delivered needs a price; no
price change once delivered; a price can't be removed or set below the
payments), `payments_guard` (no payment on an unpriced order; payments never sum
past the total; no edit/delete once delivered), `order_price_history` is
append-only (trigger), and `payments.order_id` is `ON DELETE RESTRICT`. The
integration fixtures clean up with `session_replication_role = replica` for the
payment rows only -- the local test role may set it; the production runtime role
can't.

### Payment ledger

The `payments` table (`modules/payments/`) is the multiple-dated-entries
ledger; `amountPaid`/`outstanding` on every `Order` response are always the
real `SUM(payments.amount)` (`DrizzleOrdersRepository.sumPaymentsForOrder`/
`sumPaymentsForOrders`) -- never stored, always derived at read time.

**Ledger writes are atomic and concurrency-safe.** The three mutations
(`recordPayment`/`editPayment`/`removePayment` in
`drizzle-payments.repository.ts`) each run in one transaction that first locks
the order row (`SELECT ... FOR UPDATE`), then re-reads the ledger sum, enforces
the no-overpayment invariant, writes, and recomputes `payment_status`. So two
staff recording a payment on the same order at once serialize -- one commits,
the other re-reads the updated sum under the lock and is rejected with
`PAYMENT_EXCEEDS_TOTAL` -- instead of both passing a stale check and overpaying
(the same row-lock pattern as `updateStatus`; proven by a concurrency
integration test). See ADR 0005.

**Money — one way, decimal, string on the wire.** All money is `numeric(12,2)`
in Postgres and crosses every boundary (entity, DTO, JSON, and the frontend) as
a 2-decimal **string** like `"1500.00"` — never a JS `number` (JSON numbers are
IEEE-754 floats and can drift; a string is exact). `common/money/money.ts` is
the single place money math/formatting happens (wraps **decimal.js**, half-up
rounding): `money()`, `toMoneyString()`, `addMoney`, `subtractMoney`,
`outstanding`, `moneyGreaterThan`, `moneyGte`, `isPositiveMoney`. Inbound money
is validated + normalised by `moneyField`/`positiveMoneyField`
(`common/money/money-schema.ts`), which accept a number _or_ a string and emit
the canonical 2-dp string. Never do `+ - > Number() parseFloat` on money — add a
helper to `money.ts` instead. Documented on the wire as the `Money`/`MoneyInput`
schemas in `openapi.yaml`; see ADR 0005.

**`payment_status` is DERIVED from the ledger, never chosen by hand**
(`derivePaymentStatus`, a small deliberate duplicate in both the Orders and
Payments domains -- Domain layers don't import across modules, see ADR 0003):
`unpaid` (nothing recorded) -> `advance_paid` (some, below the total) ->
`fully_paid` (recorded sum reaches the total). A **₹0 total is `fully_paid`**
-- free work (promotions, friends, design contests) has nothing to collect, so
it never shows in Pending Payments; editing the total up later re-derives it
(migration `20261005000001` fixed the older ₹0 rows). Because it's derived, the
old manual-status class of bugs (status disagreeing with the ledger) is gone:

- `CreateOrderRequest` no longer accepts `paymentStatus`; a new order starts
  `not_priced` (or `unpaid` / `fully_paid` when priced at booking). Once it's
  priced, an advance is recorded as a ledger entry, which syncs the status.
- Every ledger write (`POST`/`PATCH`/`DELETE` on a payment) recomputes the
  order's status from the new sum and writes it back via
  `PaymentsRepository.updateOrderLedgerState` (a cross-module
  Infrastructure-to-Infrastructure write into the Orders-owned `orders`
  table, the same table the payments repo already reads). The same write
  reschedules `next_payment_date`: cleared once fully paid, or set to the
  request's `nextPaymentDate` while a balance remains (fixing a stale
  "due today" after a same-day payment).
- `PATCH /orders/:id` doesn't accept `paymentStatus` either, and can't change
  the total; `PUT /orders/:id/price` re-derives the status server-side.

The `sum(ledger) <= total_amount` invariant is guarded from **both**
directions, so an order can never be "overpaid" (which would silently inflate
collected revenue):

- **Payment side** -- `assertDoesNotExceedTotal` (`PAYMENT_EXCEEDS_TOTAL`, 400):
  a payment can't push the recorded sum over `total_amount`.
- **Order side** -- `decidePriceChange` (`ORDER_TOTAL_BELOW_PAID`, 400): a
  discount can't take `total_amount` below the sum already collected; the
  message states the largest discount possible. No payment is ever removed to
  make room (ADR 0008).

Currency comparisons round to the cent (`Math.round(amount * 100)`) to avoid
float noise.

**Access**: `payments:read` gates `GET`, `payments:manage` gates `POST` (owner,
accountant, the order's own designer) and `payments:correct` gates `PATCH`/`DELETE`
(owner and accountant only) on `/orders/:orderId/payments[/:paymentId]` at the
router level (`requireCapability`). Under the order lock the repository also
refuses a payment on an unpriced order (`409 PAYMENT_ORDER_NOT_PRICED`) and any
edit/delete once the order is delivered (`409 PAYMENT_LOCKED_AFTER_DELIVERY`);
the service refuses a `paidAt` after the shop's today (`400 PAYMENT_DATE_INVALID`);
a `designer`'s "assigned" scope is additionally checked in
`PaymentsService.loadOrderForAccess` against the order's `designer_id` --
`master_tailor` has no path to this data at all: not the router (403
immediately), not the RLS policy on `payments` (no `master_tailor` branch,
unlike `orders`/`order_images`), and not the `Order` response's payment
fields (stripped, see above).

### Authenticated view-only single-order access

The `GET /orders` **list** stays strictly row-scoped (a Designer/Master Tailor
sees only their own orders). A single `GET /orders/:id`, though, is relaxed:
any authenticated user may open one order (reached via its QR code or a shared
link), read-only. `OrdersService.getOrder` first tries the row-scoped
`findById`; on a miss it falls back to `findAnyById` (unscoped) and, if the
order exists, presents it with `{ viewOnly: true }` — which force-strips every
payment field regardless of role, and the caller sees an `amountPaid` of 0. A
genuinely missing order still 404s. Writes and the payment ledger are
unaffected: `PATCH /orders/:id/status` still returns 403 for a non-assigned
user, and `GET /orders/:id/payments` still 403s — view-only means _view_, and
never exposes money. The web detail page mirrors this: it shows a "view only"
banner and hides the status-history feed (which is itself row-scoped and names
who changed what) for an outsider, leaving the visual status tracker as the
only progress indicator. Anonymous (unauthenticated) users get nothing — this
is an authenticated-only relaxation.

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

**Tiered stage RBAC + forward-only, not the flat `orders:edit:*` capabilities.**
`PATCH /orders/:id/status` is deliberately _not_ gated by a
`requireCapability` middleware call: which capability applies depends on the
_target_ status in the request body, which isn't known until it's parsed, so
`OrdersService.updateStatus` delegates the authorization decision to
`domain/order-status.rules.ts`'s `assertCanChangeStage(role, newStatus)` (same
pattern `updateOrder` uses for its field-split check, via
`assertFieldsEditable`). Each of the 16 stages maps to one of four capability
tiers via `STAGE_CAPABILITY` in `domain/order-status.ts` (see ADR 0005 and 0008):

- `orders:status:design` — Design Pending, Design Approved (owner / designer /
  production_manager)
- `orders:status:pm_received` — Production Manager Received (owner /
  production_manager only)
- `orders:status:production` — Falls/Kutchu … Finishing, incl. Dyeing and
  Marking (owner / designer / production_manager / worker / master_tailor)
- `orders:status:finalization` — Quality Check / Trail, Alteration, Ready, Delivered
  (owner / designer / production_manager — **not** master_tailor or worker:
  these are sign-off stages, so the floor can't move an order into them)

The check is a **pure tier check with no ownership/`"assigned"` restriction** —
whoever's role can reach a stage may advance any order to it (the earlier
assigned-only rule was removed in ADR 0005). Movement is **forward-only with one
loop** (ADR 0008): the repository locks the row (`SELECT … FOR UPDATE`), reads
the current stage, and `assertStageMove` rejects any move to an equal-or-earlier
stage with `409 ORDER_STATUS_NOT_FORWARD` -- except **Ready -> Alteration**, so a
garment can go Ready -> Alteration -> Ready as often as needed -- and any move
into Delivered from a stage other than Ready with
`409 ORDER_DELIVER_REQUIRES_READY`. The database enforces Delivered-only-from-
Ready too (trigger `orders_guard_stage_change`), so no other write path can skip
it. The main path is QC -> Ready -> Delivered; `nextMainStage` (what a QR scan
offers) never suggests Alteration. Re-applying the current stage is a no-op
(no duplicate history row) and blocks reverts, and the row lock serialises two
people advancing the same order at once (the loser gets the same 409) — see the
concurrency integration test asserting `[200, 409]`.

**No skipping past a gated stage.** A tier used to be enforced only for moving
*into* a stage, never for jumping *over* it — so a designer could go Design
Approved → Falls/Kutchu and skip Production Manager Received entirely, despite
being unable to set it. `assertCanSkipStages(role, current, target)` now refuses
a forward jump that passes over any stage the caller couldn't set
(`403 ORDER_STATUS_TRANSITION_FORBIDDEN`). Ordinary skips still work — anyone who
can reach Machine Work can also set Hand Work, so an order needing no hand work
jumps straight past it. It needs the *current* stage, so it runs inside the same
row-locked transaction as the forward-only check: the service passes it to
`repository.updateStatus` as a guard, keeping the rule in the domain layer while
enforcing it against the locked value rather than a possibly stale read.

`PRODUCTION_STAGE_STATUSES` is a *reporting* grouping defined by position —
Falls/Kutchu through Delivered — not by permission tier. Deriving it from the
tier would have silently dropped Quality Check and Alteration out of that count
when the finalization tier was split off. The dashboard's "In Production" count
is that grouping minus Ready and Delivered; Ready has its own card ("Ready for
delivery", `stats.ready`, bucket `ready`). "Delivered" on the dashboard is
`deliveredThisMonth` (bucket `delivered_this_month`): orders whose Delivered
stage-history row falls on or after the 1st of this month in
`BUSINESS_TIMEZONE` -- not every delivered order ever (`completed` is still
returned for older web builds).

### Product catalogue — validated in the API, not the database

`domain/product-categories.ts` holds 47 categories in 6 collections (Upper
Body, Full Body, Lower Body, Mens Wear, Kids Wear - Girls, Kids Wear - Boys),
mirrored in needleye-web. The create/update DTOs build their zod enum from
`PRODUCT_CATEGORY_VALUES`, and **that is the only validation**: migration
`20260924000002` dropped the database CHECK on `orders.product_category`, so
adding a category is a code change here and never a migration. Safe because the
API is the sole writer to `orders` (service_role; `authenticated` has select
only). Contrast `production_status`, whose CHECK is kept on purpose — stages
change rarely and a bad value corrupts the production flow.

Rules for editing the list: **never change or remove an existing `value`** —
every order row stores it, so a rename orphans them (labels are display-only
and can change freely). `value`s are correctly spelled even where a label keeps
the business's own spelling ("Plazo" → `palazzo`), so a label can
be fixed without touching data. Mens Wear / Kids Wear values carry a `mens_` /
`kids_` prefix, which is what keeps the repeated labels "Shirt", "Pant" and "Skirt"
distinct (the web shows them as e.g. "Shirt (Mens Wear)" outside the picker). `src/docs/openapi.test.ts` fails if `openapi.yaml`'s `ProductCategory`
(or `GranularStatus`) enum drifts from the code.

### Delivery capacity — a soft daily cap with a recorded override

The workshop can hand over about `DELIVERY_DAY_CAPACITY` orders a day (default
10). Every order whose `due_date` is that day counts: any status, any payment
state, delivered or not. The day is the booking unit, and nothing else is
filtered.

- **`GET /orders/delivery-load?from&to[&excludeOrderId]`** returns the count per
  day (days with no orders are omitted), plus `capacity` and `nearCapacity`
  (80%, rounded up). The web calendar colours days by these values. The range
  is at most 200 days. `excludeOrderId` leaves out the order being edited, so it
  doesn't count against its own day. Gated by `orders:create` (owner /
  designer / PM), which covers every role that can set a due date.
- **Booking a full day is refused, not blocked outright.** Create, and any edit
  that *changes* `dueDate`, fails with 409 `DELIVERY_DAY_FULL` and details
  `{dueDate, booked, capacity}`. It goes through only when the request carries
  `confirmedWithProductionManager: true`. That flag is not an order field: it is
  stripped before the DTO field checks. When it is used on a full day, the
  service writes an `order.delivery_override` audit entry after commit
  (`{dueDate, capacity, bookedBefore}`, actor = the caller). An edit that keeps
  the same date is never re-checked, because the order already holds its slot.
- **Race-safe, the same way as the status rules.** The check
  (`delivery-capacity.rules.ts` → `checkDeliveryDayCapacity`) is handed to
  `repository.create` / `update` as a guard. Inside the transaction, the
  repository takes `pg_advisory_xact_lock(4201, hashtext(due_date))` for that
  day (an edit also locks its own row `for update` first, to read its current
  date), counts, runs the guard, then writes. Two bookings for the last slot
  therefore serialise, and the second gets a 409. Different days never wait on
  each other. `tests/integration/delivery-capacity.integration.test.ts` proves
  it with a transaction that holds the day's lock. That test was checked
  against a build with the lock removed, and it fails there.

No migration: `due_date` was already indexed, and the lock is an advisory lock,
not a table.

### Owner reports — who is working, and what happened each day

`modules/reports/` backs the web's `/reports` page. The whole module is
gated by `reports:staff`, which only `owner_manager` has.

- **`GET /reports/staff-activity`** lists every *active* designer, master
  tailor, production manager and worker as `working` or `idle`. The owner and
  accountant are never listed.
  - A **designer** is Working while they have **created** an undelivered order
    in the last **45** days.
  - Everyone else is Working while they made the **most recent stage move** on
    an undelivered order in the last **30** days. "Most recent" matters: when a
    later stage move by someone else happens, the order passes to that person.
    For each OPEN order it takes the single latest move
    (`LATERAL … ORDER BY created_at DESC LIMIT 1` on
    `order_status_history (order_id, created_at)`), so delivered orders'
    history is never read.
  - **Searched, filtered and paged in the database**: `?q=` (name, LIKE
    wildcards escaped), `?role=`, `?status=`, `?limit=` (max 50) and
    `?offset=`. It returns one page, `total`, and `counts` (Working/Idle over
    the search + role filter, for the summary tiles). One query whatever the
    page size; "last seen" is probed only for the rows on the page. The Staff
    Report's person picker uses the same endpoint with `role=`.
  - `openOrders` is how many orders qualify. `lastSeenAt` is their latest
    audited action of any kind. The windows live in
    `domain/staff-activity.rules.ts`, and the response echoes them so the UI
    never hard-codes them.
- **`GET /reports/activity-days`** returns today and the 6 days before it, in
  the shop's timezone. It doesn't query the database.
- **`GET /reports/activity?day&limit&offset`** returns one day of the audit
  trail, newest first, paginated (at most 100 per page). Each event carries the
  actor's name and role, plus the order number or account name.
  - `payment.*` events are excluded: those are the Revenue & Ledger feed.
  - A day outside the last 7 gets a 400. The web loads each day only when the
    owner opens it.
- **Days are shop days.** `BUSINESS_TIMEZONE` (default `Asia/Kolkata`) defines
  midnight. The repository turns the day into a UTC range
  (`(day::date)::timestamp at time zone tz` up to the next day), so the
  `created_at` index is still used. A plain UTC day would run 05:30 to 05:30 in
  India.

Indexes (from the query audit, see `docs/performance/`): the partial
`orders_open_created_idx` (open orders only) and
`audit_log (actor_id, created_at desc)` in migration
`20260925000001_reporting_indexes.sql`. The staff report's weekly "completed"
count uses the partial `order_status_history_completed_idx`
(`20260925000002_completed_events_index.sql`).
`order.updated` audit metadata lists the fields the form *submitted*, not only
the ones that changed, so the web feed just says "Edited order …".

### Leads and the public enquiry form

`modules/leads/` (ADR 0007 has every decision). A lead is a customer enquiry --
from the **public enquiry form** (`/enquiry` on the web, no login) or added by
the owner -- that a designer works until it becomes an order or is closed.

- **Access:** `leads:read` (owner every lead; a designer only theirs -- anyone
  else's answers **404**, so existence never leaks) and `leads:manage` (owner:
  add, assign, discard, any stage). Everyone else: 403.
- **Stages** (`lead-status.rules.ts`): New -> Assigned -> Unattended (the
  designer's "Received") -> Attended <-> Follow-up -> Converted / Lost;
  Discarded = the owner's spam bin for unassigned leads. `assigned` only via
  `PATCH /leads/:id/assign`; `converted` only by saving an order with
  `leadId` -- converted **inside the order's insert transaction**
  (`lead-conversion.ts`), so an order without its conversion (or the reverse)
  can't exist (`409 LEAD_NOT_CONVERTIBLE`). Stage changes lock the row
  (`FOR UPDATE`) and accept a `version` (`409 LEAD_MODIFIED`).
- **Badge:** `GET /leads/badge` -- owner: unassigned New leads; designer: their
  leads waiting for Received + their open urgent ones. One indexed count.
- **No whole-team lists:** the owner's Designers table is `GET /leads/designers`
  (name search + page of 10), and picking a designer (filter, assign) uses the
  type-ahead `GET /team-members?role=designer&q=&limit=8` -- so 300 designers
  cost the same as 3.
- **Repeat enquiries:** per phone, 24 h from the first: the 2nd merges into the
  lead (history note, `enquiry_count` 2, **urgent**, reopens Lost/Discarded);
  the 3rd+ stores nothing and gets a calm "already received" reply. Serialised
  per phone with `pg_advisory_xact_lock(4202, hashtext(phone))`.
- **The public endpoint** is the only unauthenticated write. Mounted at
  `/api/v1/public` **before** the global JSON parser with an 8 kB limit;
  5/IP/hour + 200/hour overall; strict schema; a honeypot field; a signed
  open-time token (< 3 s = bot, forged/expired = reload); Cloudflare Turnstile
  built in but **off** (`TURNSTILE_ENABLED`, guide:
  `docs/guides/turn-on-turnstile.md`). Bot-like submissions get the normal
  reply and are not stored. The reply never echoes data. All SQL is
  parameterised. `npm run test:public-form -- --base=<api>/api/v1` checks it
  without credentials or writes.
- **Malformed / oversized JSON** anywhere in the API now answers 400
  `MALFORMED_REQUEST` / 413 `PAYLOAD_TOO_LARGE` (previously a misleading 500
  "database error").
- **Tables** (`20261006000001_leads.sql`): `leads`, `lead_comments`,
  `lead_events`, `lead_counters` -- RLS on with no policies (API only).
  Indexes cover stage lists, a designer's leads/badge, the per-phone check and
  trigram search; `npm run test:perf` audits all of it at 20k leads.

### Dashboard stats & revenue report

`GET /orders/stats` (`DrizzleOrdersRepository.getStats`) computes
`total`/`active`/`completed`/`thisMonth`/`inProduction`/`overdue`/`urgent`
plus the payment aggregates `pendingPayments`/`collectedRevenue`/`outstandingRevenue`
entirely in Postgres -- one query with `COUNT(*) FILTER (WHERE ...)` for the
order-level counts (`active`/`completed`/`inProduction` derived from the same
`COMPLETED_CANONICAL_STAGES`/`CANONICAL_TO_GRANULAR`/`PRODUCTION_STAGE_STATUSES`
vocabulary the Kanban board groups by, not a separate definition;
`overdue`/`urgent` from `due_date` vs `current_date`), one more joining
`payments` for `collectedRevenue`. Never fetches every order into Node and
reduces -- same "aggregate in the database" principle as `sumPaymentsForOrder(s)`.
Row-scoped the same way `GET /orders` is (`rowScopeCondition`), and the three
payment-related fields are stripped by `order-stats.presenter.ts` for callers
without `payments:read` (master_tailor) -- a Master Tailor's response has only
the seven non-payment counts, no payment keys at all. Registered before
`GET /orders/:id` in `orders.routes.ts` so Express doesn't match `stats` as
the `:id` param.

Each dashboard card deep-links into a matching filtered list via the
`?bucket=` query param on `GET /orders` (`active`, `production`, `completed`,
`ready`, `delivered`, `pending_payment`, `payment_overdue`, `payment_upcoming`,
`overdue`, `urgent`, `this_month`); `DrizzleOrdersRepository.bucketCondition`
translates the bucket into the same WHERE clause the stat count used, so a card
and the list it opens always agree. The `payment_overdue`/`payment_upcoming`
buckets (outstanding balance with a next-payment date past / still ahead) back
the dedicated pending-payments page's Overdue / Upcoming filter.

`GET /orders/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD` (`getMonthlyRevenue`,
`reports:financial` only) returns collected revenue grouped into accounting
periods over an inclusive date window (the UI sends a whole-year span so an
accountant can export any year range; defaults to the last 12 months). Period
boundaries follow `ACCOUNTING_CYCLE_START_DAY` (1 = calendar months by default;
e.g. 7 gives 7th-to-6th billing cycles), computed in SQL with `date_trunc` +
`make_interval` over the `payments` ledger.

`GET /orders/ledger-events?from=&to=&limit=&offset=` (`getLedgerEvents`,
`reports:financial` only) is the **payment audit trail** behind the revenue
page's "Ledger Activity" section: every payment recorded / edited / removed in
the window, newest first, decoded for display (who, when, which order, and what
changed — before/after amounts for an edit, a signed amount for a
record/removal). It reads the append-only `audit_log` (`entity_type =
'payment'`), joining `profiles` for the actor name and `orders` for the order
number via the event's `metadata->>'orderId'`; nothing is mutated. The write
side enriches this: `PaymentsService.updatePayment` now records a full
`before`/`after` snapshot so an edit is legible in the feed. Paginated (the
UI's year/month/week filters map to a `[from, to]` here). A composite index
`audit_log (entity_type, created_at desc)` backs the equality+range+order
access pattern. Registered before `/orders/{id}` so `ledger-events` isn't
matched as an order id. Days are the **shop's** days (`BUSINESS_TIMEZONE`), so
a payment at 00:30 IST on 1 July files under July, not June.

`GET /orders/ledger-events/export?from=&to=` (`getLedgerExport`, same
audience) backs the Ledger Activity **Export CSV / Export PDF** buttons: every
event of **one week or one month** in a single unpaged response (same rows and
shape as the feed). Both dates are required; a window over 31 days (a year) is
refused with `LEDGER_EXPORT_RANGE_INVALID`, and more than 5000 entries with
`LEDGER_EXPORT_TOO_LARGE` instead of a partial file (`orders/domain/ledger-export.rules.ts`).
The web builds the CSV in the browser and the PDF is a print page -- no new
table, no migration.

### Authentication

`needleye-web` holds **no Supabase SDK at all** -- every auth operation goes
through this API's `modules/auth` endpoints, which are thin, stateless
wrappers around Supabase Auth:

| Endpoint                                             | What it does                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /auth/login`                                   | email+password → `{ accessToken, refreshToken, expiresAt, profile }`                              |
| `POST /auth/refresh`                                 | rotates a refresh token for a new pair                                                            |
| `POST /auth/logout`                                  | revokes the session server-side (`auth.admin.signOut`) -- not just "forget the token client-side" |
| `POST /auth/password-reset-request`                  | always 204, whether or not the email matches an account (never leaks existence)                   |
| `POST /auth/password-update`                         | requires a bearer token; updates the caller's own password                                        |
| `POST /auth/exchange-code`                           | exchanges a PKCE `?code=` from an email link for a session, for projects configured that way      |
| `POST /auth/qr-login`                                | Master Tailor QR login -- see "Account creation, passwords, and QR login" below                   |
| `GET /auth/me`                                       | the caller's profile, from the bearer token                                                       |
| `GET /auth/bootstrap-status`, `POST /auth/bootstrap` | one-time first-Owner/Manager setup, self-disabling once an owner exists                           |

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
- **QR login** (`designer`, `master_tailor`, `production_manager` and `worker`, `QR_LOGIN_ROLES` -- never `owner_manager` or `accountant`: a printed card is a bearer credential, and those two roles hold the pricing/payment/staff powers; for everyone else it's an extra way in, their password login is unaffected): `POST /users/:id/qr-token` generates a high-entropy opaque token, stores only its SHA-256 hash (`qr_login_tokens` -- a table with no `anon`/`authenticated` grant at all, reachable only through this API's service-role client; see the migration comment for why it isn't just a column on `profiles`), and returns the raw token/URL once. Regenerating -- or deactivating the account -- immediately invalidates the previous one. `POST /auth/qr-login` verifies the hash, then mints a real session via Supabase's admin `generateLink` (magic-link type) immediately redeemed server-side via `verifyOtp` -- the link is never emailed, `generateLink` is used purely as an internal "issue a session for this user" primitive. See the Flow Map's QR diagrams.
- **Listing & lifecycle**: `GET /users` is server-side searchable (name/email, case-insensitive) and offset-paginated (`{ users, total, limit, offset }`, `limit` clamped 1-100) -- the admin screen never loads every account at once. `GET /users/:id` backs the per-user detail page. Deactivation is reversible: `POST /users/:id/reactivate` flips `profiles.active` back on and lifts the Supabase Auth ban (`unbanUser`); a fresh QR must be re-issued since deactivation cleared the old one.
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

These diagrams show _how_ a request moves through the layers described
above -- the OpenAPI doc above covers _what_ each endpoint accepts/returns.

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

### Generate a staff member's QR login card, then use it

Cards can be issued to Designer, Master Tailor, Production Manager and Worker
accounts. The sign-in half (`POST /auth/qr-login`) has no role check of its own
-- it only redeems tokens this issuing step produced.

```mermaid
sequenceDiagram
    participant Owner as needleye-web (logged in)
    participant API as needleye-api
    participant Svc as UsersService / AuthService
    participant Repo as DrizzleUsersRepository / DrizzleAuthRepository
    participant SB as Supabase Auth
    participant Master as Staff member's phone

    Owner->>API: POST /users/:id/qr-token
    API->>Svc: generateQrToken(targetId)
    Svc->>Repo: findById(targetId)
    alt role is owner_manager or accountant
        Svc-->>Owner: 400 USER_QR_ROLE_UNSUPPORTED
    else designer / master_tailor / production_manager / worker
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

### Record a payment (status derived + synced from the ledger)

```mermaid
sequenceDiagram
    participant User as needleye-web (owner_manager / accountant / assigned designer)
    participant PayAPI as api/payments.routes.ts
    participant PaySvc as PaymentsService
    participant PayRepo as DrizzlePaymentsRepository

    User->>PayAPI: POST /orders/:orderId/payments { amount, method, nextPaymentDate? }
    PayAPI->>PaySvc: addPayment(ctx, orderId, dto)
    PaySvc->>PayRepo: findOrderContext(orderId)
    PayRepo-->>PaySvc: { designerId, totalAmount }
    alt scope is "assigned" and caller isn't the order's designer
        PaySvc-->>PayAPI: throws ForbiddenError
    else access ok
        PaySvc->>PayRepo: sumByOrderId(orderId)
        PaySvc->>PaySvc: assertDoesNotExceedTotal(sum + amount, totalAmount)
        Note over PaySvc: 400 PAYMENT_EXCEEDS_TOTAL if the new sum would overpay
        PaySvc->>PayRepo: create(record)
        PaySvc->>PaySvc: derivePaymentStatus(sum + amount, totalAmount)
        PaySvc->>PayRepo: updateOrderLedgerState(orderId, { paymentStatus, nextPaymentDate })
        Note over PayRepo: cross-module Infra->Infra write into the Orders-owned<br/>orders table (ADR 0003). Status: unpaid -> advance_paid -> fully_paid;<br/>next date cleared once fully paid, else set to the supplied date
        PayAPI-->>User: 201 { payment }
    end
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
    Svc->>Rules: assertCanChangeStage(role, status)
    Rules->>Rules: getCapabilityScope(role, STAGE_CAPABILITY[status])
    alt role's tier can't reach this stage
        Rules-->>Svc: throws ForbiddenError (403)
    else allowed
        Svc->>Repo: updateStatus(id, status, callerId)
        Repo->>DB: BEGIN; SELECT production_status FROM orders WHERE id = :id FOR UPDATE
        DB-->>Repo: current stage (row locked)
        alt stageIndex(status) <= stageIndex(current)  (revert, re-apply, or lost race)
            Repo-->>Svc: throws ConflictError (409 ORDER_STATUS_NOT_FORWARD)
        else forward move
            Repo->>DB: UPDATE orders SET production_status, updated_by
            Repo->>DB: INSERT INTO order_status_history (status, label, changed_by)
            Note over Repo,DB: one transaction + row lock -- forward-only, race-safe, no duplicate history
            DB-->>Repo: committed
            Repo-->>Svc: OrderEntity
            Svc-->>API: OrderResponseDto
            API-->>User: 200 { order }
        end
    end
```

### Book an order's due date (delivery capacity)

```mermaid
sequenceDiagram
    participant User as needleye-web (owner_manager / designer / production_manager)
    participant API as api/orders.routes.ts
    participant Svc as OrdersService
    participant Rules as delivery-capacity.rules.ts
    participant Repo as DrizzleOrdersRepository
    participant DB as Postgres (transaction)
    participant Audit as audit_log

    User->>API: GET /orders/delivery-load?from=D&to=D (as the date is picked)
    API-->>User: 200 { capacity, nearCapacity, days }  (the UI shows available / full)
    User->>API: POST /orders { dueDate: D, ..., confirmedWithProductionManager? }
    API->>Svc: createOrder(ctx, body)  (flag stripped from the order fields)
    Svc->>Repo: create(data, guard)
    Repo->>DB: BEGIN; pg_advisory_xact_lock(4201, hashtext(D))
    Repo->>DB: SELECT count(*) FROM orders WHERE due_date = D
    DB-->>Repo: booked
    Repo->>Rules: guard({ booked, previousDueDate: null })
    alt booked >= capacity and not confirmed
        Rules-->>Repo: throws ConflictError (409 DELIVERY_DAY_FULL, {dueDate, booked, capacity})
        Repo-->>User: 409 (rolled back) -> the web reopens the full-day dialog
    else room left, or confirmed with the Production Manager
        Repo->>DB: INSERT INTO orders ...; COMMIT (lock released)
        opt the day was full (override used)
            Svc->>Audit: order.delivery_override {dueDate, capacity, bookedBefore}
        end
        Svc-->>User: 201 { order }
    end
    Note over Repo,DB: PATCH /orders/:id is the same, plus SELECT due_date FOR UPDATE first; unchanged date = no check
```

### Owner reports (team status + lazily loaded daily activity)

```mermaid
sequenceDiagram
    participant Owner as needleye-web /reports (owner_manager)
    participant API as api/reports.routes.ts
    participant Svc as ReportsService
    participant Rules as staff-activity.rules.ts
    participant Repo as DrizzleReportsRepository
    participant DB as Postgres

    Owner->>API: GET /reports/staff-activity?q=&role=&status=&limit=20&offset=0 (search debounced in the web)
    API->>API: requireCapability("reports:staff") -- anyone else 403
    API->>Svc: getStaffActivity()
    Svc->>Repo: getStaffWorkload({ designerWindowDays: 45, floorWindowDays: 30 })
    Repo->>DB: ONE query: staff (q/role filter) + open orders created (designers) + LATERAL latest move per open order (floor) + counts + page (limit/offset) + last-seen probe for the page rows
    DB-->>Repo: rows
    Svc->>Rules: staffStatus(openOrders) -> working / idle
    API-->>Owner: 200 { windows, staff[] }

    Owner->>API: GET /reports/activity-days
    API-->>Owner: 200 { timeZone, today, days[7] }  (no DB; days are closed in the UI)
    Owner->>API: GET /reports/activity?day=D  (only when the owner opens day D)
    Svc->>Rules: assertActivityDay(D, today in BUSINESS_TIMEZONE) -- else 400
    Svc->>Repo: getActivityDay(D, tz, exclude "payment.", limit, offset)
    Repo->>DB: audit_log where created_at in [D 00:00, D+1 00:00) shop time, action not like 'payment.%'
    API-->>Owner: 200 { events, total }  ("Show more" asks for the next offset)
```

### A public enquiry becomes an order (Leads)

```mermaid
sequenceDiagram
    participant C as Customer (needleye-web /enquiry, no login)
    participant P as api/public-enquiries.routes.ts
    participant Svc as LeadsService
    participant Repo as DrizzleLeadsRepository
    participant DB as Postgres
    participant O as Owner / Designer (signed in)
    participant Ord as OrdersService + repository

    C->>P: GET /public/enquiry-form
    P-->>C: { formToken (signed open time), turnstileSiteKey | null }
    C->>P: POST /public/enquiries { name, phone, requirement, formToken, website }
    P->>P: 8 kB body limit, 5/IP/h + 200/h, strict schema (else 413 / 429 / 400)
    P->>Svc: submitPublicEnquiry
    Svc->>Svc: honeypot / too fast -> "received", nothing stored; bad token -> 400; Turnstile if on
    Svc->>Repo: submitEnquiry(normalised fields)
    Repo->>DB: advisory lock(phone); latest lead for phone FOR UPDATE; create | merge (urgent) | limit
    P-->>C: 201 received / 200 already_received (fixed wording, no data)

    O->>Svc: PATCH /leads/:id/assign (owner) -> Assigned; designer badge +1
    O->>Svc: PATCH /leads/:id/status { unattended } (designer "Received") -> badge -1
    O->>Svc: POST /leads/:id/comments ... PATCH status attended / follow_up
    O->>Ord: POST /orders { ...order, leadId } (from "Converted" -> Create order)
    Ord->>DB: one transaction: insert order + history, convertLeadInTransaction (status in convertible stages, caller's lead) -> converted + event
    Ord-->>O: 201 order (or 409 LEAD_NOT_CONVERTIBLE and no order)
```

### Route map -- every endpoint, at a glance

| Method & path                                 | Auth   | Capability                                             | Controller             | Service method                          | Repository method                                                                 |
| --------------------------------------------- | ------ | ------------------------------------------------------ | ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| GET `/auth/me`                                | bearer | --                                                     | auth.routes.ts         | (none -- `req.profile` from middleware) | --                                                                                |
| GET `/auth/bootstrap-status`                  | none   | --                                                     | auth.routes.ts         | `getBootstrapStatus`                    | `countOwnerManagers`                                                              |
| POST `/auth/bootstrap`                        | none   | --                                                     | auth.routes.ts         | `bootstrap`                             | `countOwnerManagers`, `createOwnerManagerUser`                                    |
| POST `/auth/login`                            | none   | --                                                     | auth.routes.ts         | `login`                                 | `signInWithPassword`, `getProfile`                                                |
| POST `/auth/refresh`                          | none   | --                                                     | auth.routes.ts         | `refresh`                               | `refreshSession`, `getProfile`                                                    |
| POST `/auth/logout`                           | bearer | --                                                     | auth.routes.ts         | `logout`                                | `signOut`                                                                         |
| POST `/auth/password-reset-request`           | none   | --                                                     | auth.routes.ts         | `requestPasswordReset`                  | `requestPasswordReset`                                                            |
| POST `/auth/password-update`                  | bearer | --                                                     | auth.routes.ts         | `updatePassword`                        | `updatePassword`                                                                  |
| POST `/auth/exchange-code`                    | none   | --                                                     | auth.routes.ts         | `exchangeCode`                          | `exchangeCodeForSession`, `getProfile`                                            |
| POST `/auth/qr-login`                         | none   | --                                                     | auth.routes.ts         | `qrLogin`                               | `signInWithQrToken`                                                               |
| GET `/users`                                  | bearer | `users:manage`                                         | users.routes.ts        | `listUsers`                             | `findMany`, `countMany` (searchable, paginated)                                   |
| GET `/users/:id`                              | bearer | `users:manage`                                         | users.routes.ts        | `getUser`                               | `findById`                                                                        |
| POST `/users`                                 | bearer | `users:manage`                                         | users.routes.ts        | `createUser`                            | `createUser`                                                                      |
| POST `/users/:id/generate-password`           | bearer | `users:manage`                                         | users.routes.ts        | `generatePassword`                      | `findById`, `setPassword`                                                         |
| POST `/users/:id/qr-token`                    | bearer | `users:manage`                                         | users.routes.ts        | `generateQrToken`                       | `findById`, `setQrToken`                                                          |
| PATCH `/users/:id`                            | bearer | `users:manage`                                         | users.routes.ts        | `updateUser`                            | `updateProfile`                                                                   |
| POST `/users/:id/deactivate`                  | bearer | `users:manage`                                         | users.routes.ts        | `deactivateUser`                        | `updateProfile`, `banAuthUser`, `clearQrToken`                                    |
| POST `/users/:id/reactivate`                  | bearer | `users:manage`                                         | users.routes.ts        | `reactivateUser`                        | `findById`, `updateProfile`, `unbanAuthUser`                                      |
| GET `/orders`                                 | bearer | `orders:read`                                          | orders.routes.ts       | `listOrders`                            | `findMany` (row-scoped; `?bucket=` filters; `?createdFrom=` Kanban window; `?dueOn=` one day; no images) |
| POST `/orders`                                | bearer | `orders:create`                                        | orders.routes.ts       | `createOrder`                           | `create`                                                                          |
| GET `/orders/stats`                           | bearer | `orders:read`                                          | orders.routes.ts       | `getStats`                              | `getStats` (row-scoped; registered before `/:id`)                                 |
| GET `/orders/delivery-load`                   | bearer | `orders:create`                                        | orders.routes.ts       | `getDeliveryLoad`                       | `countOrdersDueByDay` (shop-wide; registered before `/:id`)                       |
| GET `/orders/revenue`                         | bearer | `reports:financial`                                    | orders.routes.ts       | `getMonthlyRevenue`                     | `getMonthlyRevenue` (registered before `/:id`)                                    |
| GET `/orders/staff-report`                    | bearer | `reports:staff`                                        | orders.routes.ts       | `getStaffReport`                        | `getStaffReport` (one designer/master on demand; registered before `/:id`)        |
| GET `/orders/ledger-events`                   | bearer | `reports:financial`                                    | orders.routes.ts       | `getLedgerEvents`                       | `getLedgerEvents` (payment audit trail; paginated; registered before `/:id`)      |
| GET `/orders/ledger-events/export`            | bearer | `reports:financial`                                    | orders.routes.ts       | `getLedgerExport`                       | `getLedgerEvents` (one week/month, unpaged; > 31 days refused)                    |
| GET `/orders/:id`                             | bearer | `orders:read`                                          | orders.routes.ts       | `getOrder`                              | `findById` row-scoped, else `findAnyById` (view-only outsider, payments stripped) |
| PATCH `/orders/:id`                           | bearer | field-split, see below                                 | orders.routes.ts       | `updateOrder`                           | `findBasicById`, `update`                                                         |
| PATCH `/orders/:id/status`                    | bearer | stage-split, see "Order status history & Kanban" below | orders.routes.ts       | `updateStatus`                          | `findBasicById`, `updateStatus`                                                   |
| GET `/orders/:id/history`                     | bearer | `orders:read`                                          | orders.routes.ts       | `getOrderHistory`                       | `findById` (row-scoped), `listStatusHistory`                                      |
| POST `/orders/:id/images`                     | bearer | `orders:edit:customer_product_fields`                  | orders.routes.ts       | `uploadOrderImage`                      | `upsertImage`                                                                     |
| DELETE `/orders/:id/images/:slot`             | bearer | `orders:edit:customer_product_fields`                  | orders.routes.ts       | `deleteOrderImage`                      | `findImage`, `deleteImage`                                                        |
| GET `/orders/:orderId/payments`               | bearer | `payments:read`                                        | payments.routes.ts     | `listPayments`                          | `findOrderContext`, `findByOrderId`                                               |
| POST `/orders/:orderId/payments`              | bearer | `payments:manage`                                      | payments.routes.ts     | `addPayment`                            | `findOrderContext`, `sumByOrderId`, `create`                                      |
| PATCH `/orders/:orderId/payments/:paymentId`  | bearer | `payments:manage`                                      | payments.routes.ts     | `updatePayment`                         | `findOrderContext`, `findById`, `sumByOrderId`, `update`                          |
| DELETE `/orders/:orderId/payments/:paymentId` | bearer | `payments:manage`                                      | payments.routes.ts     | `deletePayment`                         | `findOrderContext`, `findById`, `sumByOrderId`, `delete`                          |
| GET `/reports/staff-activity`                | bearer | `reports:staff`                                        | reports.routes.ts      | `getStaffActivity`                      | `getStaffWorkload` (searched/filtered/paged in SQL, max 50; owner + accountant never listed) |
| GET `/reports/activity-days`                 | bearer | `reports:staff`                                        | reports.routes.ts      | `getActivityDays`                       | -- (no DB; shop-timezone day list)                                                |
| GET `/reports/activity`                      | bearer | `reports:staff`                                        | reports.routes.ts      | `getActivityDay`                        | `getActivityDay` (one shop day of audit_log, payment.* excluded, paginated)     |
| GET `/leads`                                  | bearer | `leads:read` (designer: own)                           | leads.routes.ts        | `list`                                  | `list` (stage/urgent/q/designer filters, paged, max 50)                           |
| POST `/leads`                                 | bearer | `leads:manage`                                         | leads.routes.ts        | `createManual`                          | `createManual`                                                                    |
| GET `/leads/summary`                          | bearer | `leads:read`                                           | leads.routes.ts        | `summary`                               | `summary` (counts by stage + urgent)                                              |
| GET `/leads/designers`                        | bearer | `leads:manage`                                         | leads.routes.ts        | `designerStats`                         | `designerStats` (name search + page, max 50; window-count total)                  |
| GET `/leads/badge`                            | bearer | `leads:read`                                           | leads.routes.ts        | `badge`                                 | `badgeCount`                                                                      |
| GET `/leads/:id`                              | bearer | `leads:read` (designer: own, else 404)                 | leads.routes.ts        | `detail`                                | `findById`, `listComments`, `listEvents`, `findSamePhone`                         |
| PATCH `/leads/:id/assign`                     | bearer | `leads:manage`                                         | leads.routes.ts        | `assign`                                | `isActiveDesigner`, `assign` (FOR UPDATE)                                         |
| PATCH `/leads/:id/status`                     | bearer | `leads:read` + stage rules                             | leads.routes.ts        | `changeStatus`                          | `changeStatus` (FOR UPDATE; rules re-checked on the locked row)                   |
| POST `/leads/:id/comments`                    | bearer | `leads:read` (designer: own)                           | leads.routes.ts        | `addComment`                            | `addComment`                                                                      |
| GET `/public/enquiry-form`                    | **none** | -- (120/IP/h)                                        | public-enquiries.routes.ts | `publicFormConfig`                  | --                                                                                |
| POST `/public/enquiries`                      | **none** | -- (5/IP/h, 200/h, 8 kB)                             | public-enquiries.routes.ts | `submitPublicEnquiry`               | `submitEnquiry` (advisory lock per phone)                                         |
| GET `/team-members`                           | bearer | -- (any authenticated role)                            | team-members.routes.ts | `listActive`                            | `findActive`                                                                      |

`PATCH /orders/:id` isn't gated by a single capability at the router level --
`OrdersService.updateOrder` checks `customer_product_fields`, `total` and
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
`warn` `info` `debug` `trace`, default `info`), `ACCOUNTING_CYCLE_START_DAY`
(day of month the monthly-revenue accounting period begins, 1-28, default 1 =
calendar months -- backs `GET /orders/revenue`), `DELIVERY_DAY_CAPACITY`
(orders that can be due on one day before booking it needs the Production
Manager's OK, default 10 -- see "Delivery capacity"), `BUSINESS_TIMEZONE`
(the shop's IANA timezone, default `Asia/Kolkata` -- where each day of the
owner's activity feed starts and ends; see "Owner reports"), and for the
public enquiry form (all optional, safe defaults -- see "Leads"):
`PUBLIC_FORM_SECRET`, `PUBLIC_ENQUIRY_RATE_LIMIT_MAX` (5),
`PUBLIC_ENQUIRY_RATE_LIMIT_WINDOW_MS` (1 h), `PUBLIC_ENQUIRY_GLOBAL_MAX_PER_HOUR`
(200), `TURNSTILE_ENABLED` (false), `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.

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
