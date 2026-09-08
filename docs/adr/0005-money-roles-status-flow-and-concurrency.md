# 0005: Decimal money, two new roles, a 13-stage forward-only status flow, and concurrency safety

## Status

Accepted, and complete (2026-09-01). Implemented as one feature batch across
both repos (`needleye-api` and `needleye-web`), whose `domain` copies move in
lockstep (see ADR 0001 and needleye-web's README). API contract changes: money
fields are now **strings** on the wire (breaking for any client that parsed them
as JSON numbers); two new roles and a reworked production-status vocabulary are
additive; a new `ORDER_STATUS_NOT_FORWARD` error code and forward-only status
semantics.

This ADR is the consolidated decision record the team asked for — every notable
decision from this batch, and how to extend each so future work stays
consistent.

## Context

The app was functionally complete and operationally hardened (ADR 0004), and
about to go to production. This batch closed a set of correctness, safety, and
workflow gaps surfaced by real use:

- Money was handled as JS `number` (floats). It happened to be cent-safe in the
  current code, but the pattern was a latent precision hazard and there was no
  single, enforced "one way" for the team to follow.
- The production workflow had the wrong stages, and a stage
  (`ready_for_delivery`) that had to be removed.
- Two real-world roles — a Production Manager and a shop-floor Worker — had no
  representation.
- Status changes could go backwards, be applied twice (duplicate ledger of
  history), and two people advancing the same order at once could race.

## Decisions and extension points

### 1. Money is decimal, and crosses every boundary as a string

- **One module, one way.** `src/common/money/money.ts` (mirrored at
  `needleye-web/lib/domain/utils/money.ts`) is the *only* place money math or
  formatting happens. It wraps **decimal.js** (the JS equivalent of Java's
  `BigDecimal`), configured once for `ROUND_HALF_UP`. Helpers: `money()`,
  `toMoneyString()` (canonical 2-dp string), `addMoney`, `subtractMoney`,
  `outstanding`, `moneyGreaterThan`, `moneyGte`, `isPositiveMoney` (web adds
  `paidFraction` for progress bars).
- **String on the wire.** Money stays `numeric(12,2)` in Postgres, and is a
  **string** ("1500.00") in every entity, DTO, JSON payload, prop, and React
  state — never a JS `number`. JSON numbers are IEEE-754 floats and can drift; a
  string is exact. Inbound money is validated + normalised by one zod field
  (`moneyField` / `positiveMoneyField`; web mirror in
  `lib/domain/validation/money.ts`) that accepts a number *or* a string and
  emits the canonical 2-dp string.
- **Why (not a live bug fix):** this is a standards upgrade for developer-safety.
  The rule "never do `+ - > Number() parseFloat` on money — always go through the
  helpers" is documented at the top of `money.ts`.
- *Extend:* need a new money operation? Add a helper to `money.ts` (and its web
  mirror) — never reach for floats at a call site. New money field on the wire?
  Type it `string`; validate inbound with `moneyField`/`positiveMoneyField`;
  document it as `Money`/`MoneyInput` in `openapi.yaml`.

### 2. Two new roles: `production_manager` and `worker`

- Roles are now `owner_manager, designer, master_tailor, accountant,
  production_manager, worker` (`src/domain/roles.ts` + web mirror).
- **Production Manager** = a designer that can see/edit/search **any** order
  (not just assigned): `orders:read`/`orders:edit:*` are `true`, not `"assigned"`.
- **Worker** = like a master tailor for status purposes, but with **no
  dashboard**: the web nav is empty for `worker`; `/orders` redirects to
  `/scan`; a worker only scans a QR and views the order. `orders:read` is
  `"assigned"`.
- *Extend:* a new role is a row in the `CAPABILITY_MATRIX` (both repos) plus a
  `profiles_role_check` value in a migration and a seed account. The matrix is
  the single source of truth; never branch on a role name in a component.

### 3. Status permissions are three tiers, not two buckets

- The old `orders:status:design_stages` / `production_stages` split is replaced
  by three capability tiers — `orders:status:design`,
  `orders:status:pm_received`, `orders:status:production` — mapped per stage by
  `STAGE_CAPABILITY` (`src/domain/order-status.ts`). Per-stage role access:
  - **Design Pending, Design Approved** → owner / designer / production_manager
  - **Production Manager Received** → owner / production_manager only
  - **Falls/Kutchu … Delivered** → owner / designer / production_manager /
    worker / master_tailor
- The assignment restriction on status changes was **removed** — permission is
  now purely a tier check (`assertCanChangeStage(role, newStatus)` on the API;
  `canChangeStage` on the web). A designer/PM/worker/master may advance any order
  they can reach, no ownership check.
- *Extend:* to change who can move a stage, edit `STAGE_CAPABILITY` and the
  matrix — nothing else.

### 4. 13-stage, forward-only production flow

- The canonical, ordered flow is: Design Pending, Design Approved, Production
  Manager Received, Falls / Kutchu, Fabric Purchased, Cutting, Stitching, Hand
  Work, Machine Work, Finishing, Quality Check / Trail, Alteration, Delivered.
  `ready_for_delivery` was removed; existing orders on it were migrated to
  `delivered` (migration `20260807000001`).
- **Forward-only.** `STAGE_ORDER`/`stageIndex()` define the order. The repository
  update runs in a transaction that `SELECT … FOR UPDATE` locks the row, reads
  the current stage, and rejects a move to an equal-or-earlier stage with
  `409 ORDER_STATUS_NOT_FORWARD`. This makes re-applying the same stage
  idempotent-by-rejection (no duplicate history row) and blocks reverts.
- **Alteration** is flagged as `ALARMING_STATUS`: the UI renders it red with a
  ripple to signal rework.
- *Extend:* add/reorder stages in `GRANULAR_STATUSES`/`STAGE_ORDER` (both repos)
  + a `*_status_check` migration; assign each new stage a tier in
  `STAGE_CAPABILITY`.

### 5. Concurrency safety for status changes

- The `SELECT … FOR UPDATE` row lock in `updateStatus` serialises two accounts
  advancing the same order: the first commits, the second re-reads the now-later
  stage and gets `409 ORDER_STATUS_NOT_FORWARD` instead of writing a duplicate
  transition. Proven by an integration test that fires two concurrent advances
  and asserts exactly `[200, 409]`. This complements the optimistic `version`
  lock (ADR 0004) used for field edits.

### 6. QR-scan gating and QR login for workers

- The order detail page only shows the "Product received?" advance prompt when
  reached via a QR scan (`?scan=1` in the order QR URL) **and** the role can
  change status. A normal dashboard/search/table open never shows it.
- **QR login** is now available to `worker` as well as `master_tailor` (the two
  shop-floor roles): `QR_LOGIN_ROLES = ["master_tailor", "worker"]`.
- **Generate-password** is available for **every** role in User Management (the
  old "self-managed roles can't regenerate" restriction was removed).

### 7. Frontend logging + friendly transport errors

- `needleye-web/lib/logging/logger.ts` is the one web-side logger (leveled,
  structured, browser + RSC; never logs tokens). `describeFetchError` maps a raw
  transport failure — browser `Failed to fetch`, Node `ECONNREFUSED`/`ENOTFOUND`,
  `AbortError` — to a friendly, user-safe message; the technical cause is logged
  separately. `apiFetch`/`apiUpload`/`apiFetchServer` route through it, and a
  server-side unreachable API now surfaces a `503` with a friendly message rather
  than a raw stack.

## Consequences

- **Breaking for money-parsing clients.** Any consumer that read money as a JSON
  number must now treat it as a decimal string. `openapi.yaml` documents this via
  the `Money`/`MoneyInput` schemas.
- **Simpler, safer status model.** One tier check, forward-only, race-safe. No
  per-stage ownership logic to reason about.
- **Tested.** Unit tests cover the money module (both repos), the tier
  permission map, forward ordering, and the ledger rules; integration tests cover
  forward-only/idempotent/concurrent status changes and money-as-string over the
  wire. All green on 2026-09-01.

## Follow-ups (2026-09-02)

- **Payment-ledger race closed.** The overpayment window flagged as a fast-follow
  is fixed: the three ledger mutations moved into atomic, order-row-locked
  repository transactions (`recordPayment`/`editPayment`/`removePayment`) that
  re-read the sum and enforce the invariant under the lock -- same pattern as
  `updateStatus`. Proven by a new concurrency integration test (two racing
  overpayments → one `200`, one `PAYMENT_EXCEEDS_TOTAL`, ledger never exceeds the
  total). The service keeps access-control + audit; the money invariant and
  status recompute now live in the repository (infrastructure may depend inward
  on its own module's domain).
- **Database-event tracing.** Added `common/database/db-logging.ts`
  (`describeDbError`/`dbErrorLabel`): every failed query is now logged at the DB
  layer with SQLSTATE + constraint/table + a readable label, so a DB failure is
  never silent even if a caller swallows it. The pool `error` listener, the
  readiness probe (previously silent on failure), and the 5xx error middleware
  all log through it -- and it strips pg `detail`/`where` (row values / PII).
- **`trust proxy` made configurable** (`TRUST_PROXY`, default `loopback`). The
  API sits behind the Next.js session proxy (dev, over loopback) and a reverse
  proxy (prod), both setting `X-Forwarded-For`; without a matching `trust proxy`
  setting express-rate-limit throws. Previously it was only enabled in
  production, which broke rate limiting (and spewed `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`)
  in dev.
- **Environment note (not a code change).** A silent auth failure was traced to a
  local **port collision**: an editor's port forwarding was squatting on
  `127.0.0.1:54321` (IPv4), so `SUPABASE_URL=http://127.0.0.1:54321` sent auth
  calls to the wrong server (HTML back → "Unexpected token '<'"). Using
  `http://localhost:54321` (IPv6 → Docker/Kong) sidesteps it; documented in
  `.env.example`. The DB (`:54322`, direct) was unaffected.
