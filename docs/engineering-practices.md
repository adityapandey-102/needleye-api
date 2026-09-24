# Engineering practices — needleye-api

This is the rulebook for the API and database: what we do, and **why**. Each
rule is either already true everywhere in the code, or backed by a check that
fails when it is broken. The web app has its own page
(`needleye-web/docs/engineering-practices.md`).

**Scale we design for:** about 100 staff, about 300 orders a month, one
shop. After 3 years that is roughly 12k orders, 150k stage moves and
400k audit rows. Every query must stay fast at that size, so
`npm run test:perf` tests against exactly that volume.

---

## 1. Database queries

| Practice | Why | Where / how it's enforced |
| --- | --- | --- |
| **Every list is paginated and the page size is capped** (orders ≤ 100, users ≤ 100, team status ≤ 50, activity ≤ 100, ledger ≤ 100). | Without a cap, one request can fetch the whole table: slow for that user, and it takes a database connection from everyone else. | Route/DTO limits; `tests/integration/query-budget.integration.test.ts` asserts that an over-large `limit` is clamped or refused. |
| **No N+1 queries.** A list page takes the same number of queries for 5 rows as for 50. | N+1 means one query per row, so a 50-row page costs 51 round trips. It looks fine in development and falls over in production. | Relational `with:` loads (orders + designer + tailor + images in one query), `sumPaymentsForOrders(ids)` (one query per page), batched URL signing. The query-budget test counts queries at the pool for page 5 vs page 50. |
| **Aggregate in SQL, not in Node** (`count(*) filter (where …)`, `sum`, `group by`). | Fetching rows only to count them in JavaScript moves every row over the network. | Dashboard stats, staff report, team status, delivery load. |
| **Index what we filter, join and sort on**, including *partial* indexes for "the small live part of a growing table". | An index turns "read every row" into "read the few rows that match". A partial index stays small as history grows. | See the index list below; `npm run test:perf` fails on a large sequential scan that isn't an expected shop-wide total. |
| **Bound work by the live set, not by history.** For example, the team status reads only *open* orders, and each order's *latest* stage move through `LATERAL … LIMIT 1`. | Delivered orders and old history grow forever; open orders stay at a few hundred. A query that reads history gets slower every month. | `orders_open_created_idx` (partial), `order_status_history (order_id, created_at)`. |
| **No correlated subquery per output row when one grouped pass works.** | For example, the staff report's weekly chart used to rescan a person's history once per week. It is now one grouped pass: 31 ms → 0.4 ms at 3-year volume. | Review; the query audit shows it. |
| **Search uses trigram indexes, and `LIKE` wildcards in user input are escaped.** | `ILIKE '%x%'` can use a `pg_trgm` GIN index. Without escaping, a search for "50%" would match everything. | `orders_{customer_name,bill_number,order_number}_trgm_idx` (migration 20260902000001); `common/database/like-pattern.ts` (`containsPattern`). |
| **Everything parameterised.** No user input is ever concatenated into SQL. | This prevents SQL injection. The only inlined fragments are code constants (status lists, column names chosen from a fixed pair). | `sql\`…${value}…\`` binds values; review. |
| **Lazy, on-demand reports.** Load one day, one month or one person when it is asked for, never "everything, just in case". | Most of what a report *could* show is never looked at. | Activity feed (per day), delivery calendar (per visible month), staff report (per person). |

### Index inventory (and what each is for)

| Index | Serves |
| --- | --- |
| `orders (created_at desc)`, `(designer_id, created_at)`, `(master_tailor_id, created_at)` | Newest-first order lists, including a designer's or tailor's own list |
| `orders` trigram on `customer_name`, `bill_number`, `order_number` | Order search |
| `orders (due_date)` | Delivery calendar and the per-day capacity check |
| `orders (next_payment_date) where payment_status <> 'fully_paid'` | Payment-due buckets |
| `orders (created_at) include (created_by) where production_status <> 'delivered'` | Team status (open orders only). Added 2026-09-24. |
| `order_status_history (order_id, created_at)` | An order's timeline; an order's latest move |
| `order_status_history (created_at) where status = 'delivered'` | Staff report "completed per week". Added 2026-09-24; must match `COMPLETED_CANONICAL_STAGES`. |
| `payments (order_id)`, `payments (paid_at)` | Ledger per order, revenue by period |
| `audit_log (created_at desc)`, `(entity_type, created_at desc)` | Activity feed per day, ledger feed |
| `audit_log (actor_id, created_at desc)` | "Last seen" per person. Added 2026-09-24; replaced the plain `actor_id` index. |

---

## 2. Correctness and concurrency

| Practice | Why |
| --- | --- |
| **Money is `numeric` in the database, a 2-decimal string on the wire, and `decimal.js` in code.** | Floating-point loses paise: 0.1 + 0.2 ≠ 0.3. |
| **Optimistic locking on edits** (`version`) → 409 `ORDER_MODIFIED`. | Two people editing the same order can't silently overwrite each other. |
| **Row locks for stage changes; forward-only stages; no skipping stages the caller can't set.** The domain rule runs *inside* the locked transaction as a guard callback. | A check made before the lock can be stale by the time you write. |
| **Advisory lock per delivery day** before counting and booking. | Two people booking the last slot of a day must queue, not both succeed. Proven by a race test, with a negative control. |
| **Critical enums are also `CHECK` constraints in the database** (stages, payment status, roles). The product category deliberately is not. | The database is the last line of defence. Categories change often, so zod guards them (ADR 0005 amendment). |
| **Dates as `YYYY-MM-DD` strings with UTC arithmetic; "a day" means the shop's day** (`BUSINESS_TIMEZONE`). | Timezone and daylight-saving bugs shift days. A UTC day runs 05:30–05:30 in India. |

## 3. Security

| Practice | Why |
| --- | --- |
| **RBAC is enforced in the API** (capability matrix + row scope + RLS). The web only hides buttons. | Anyone can call the API directly; UI checks are not security. `npm run test:rbac` checks 77 role × endpoint cases. |
| **Payment fields are stripped server-side for roles without `payments:read`.** | Data that isn't sent can't leak. |
| **Validate every input with zod at the edge; parse queries strictly** (400 on a bad date, never silently use "today"). | A silent fallback shows the wrong data with no error. |
| **Rate-limited auth; `TRUST_PROXY` = number of proxies (2 on Railway).** | Brute-force protection only works when it keys on the real client IP (`npm run test:ratelimit`). |
| **Secrets are server-only; logs redact tokens and passwords; the audit log records who did what.** | Accountability without leaking credentials. |
| **Least-privilege database role in production** (ADR 0006). | A bug or injection can't drop tables. |

## 4. Errors, logging, operations

- **Typed `AppError`s with stable codes**, for example `DELIVERY_DAY_FULL`. One error middleware turns them into JSON, and unknown errors become a generic 500. *Why:* clients branch on codes, not message text, and internals never leak.
- **pino structured logs with request IDs, plus slow-query warnings** (`SLOW_QUERY_MS`, default 250 ms). *Why:* a production problem can be traced from one request ID.
- **Pool size is configurable** (`DB_POOL_MAX`). **Health endpoint and graceful shutdown.**

## 5. Architecture

- **Feature modules with api / application / domain / infrastructure layers** (ADR 0001); ports and repositories (ADR 0002); per-module schema ownership (ADR 0003).
- **Business rules live in `domain/` as pure functions**, unit tested without a database.
- **No shared package with the web.** Each repo keeps its own copy of the rules, and the contract is `openapi.yaml`. `src/docs/openapi.test.ts` fails if its enums drift from the code.

## 6. Migrations

- Only add new, timestamped files; never edit one that has been applied anywhere.
- Apply to **local first**, test everything, and only then to production (`npx supabase@2.117.0 db push --dry-run`, then `db push`).
- Deploy the API before the web. Prefer migrations that only *loosen* rules or *add* indexes, because they are safe to apply before the code ships.

## 7. Testing and the release checklist

The testing pyramid: many unit tests, fewer integration tests, and end-to-end tests only for critical flows.

**Run before every release (all on the local stack):**

| Command | Checks |
| --- | --- |
| `npm run typecheck && npm run lint && npm run build` | Code compiles and is clean |
| `npm run test:unit` | Domain rules |
| `npm run test:integration` | Real database behaviour, including the **query budget** (no N+1, capped pages) |
| `SEED_OWNER_PASSWORD=… npm run test:rbac` | Who can call what (77 checks) |
| `npm run test:perf` | **Query audit**: every important query on 3 years of synthetic data (rolled back), with no bad scans, ≤ 150 ms and no N+1. `--write` refreshes `docs/performance/query-audit.md`. |
| `npm run test:security` / `test:ratelimit` | Security headers and the brute-force limiter |

**When you add a new list, search or report:** add it to `scripts/perf/query-audit.ts`
(as a `case`) and to the query-budget test. If you add a scan that is intentional
(a shop-wide total), list it as `expectedScan` with the reason.
