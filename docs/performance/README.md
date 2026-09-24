# Performance audit — 24 Sep 2026

A whole-app check of database load and frontend weight, the fixes made, and
how to repeat it. The detailed, generated tables are:
- [`query-audit.md`](query-audit.md): every important query at 3-year volume.
- `needleye-web/docs/performance/bundle-budget.md`: JavaScript per page.

## How it was measured

- **Queries.** `npm run test:perf` runs 24 real repository calls (30 SQL
  statements). It records the exact SQL each one sends, then re-runs every
  statement with `EXPLAIN ANALYZE` inside a transaction holding **3 years of
  synthetic data**: 12,000 orders, 144,000 stage moves, 24,000 payments and
  360,000 audit rows. The transaction is rolled back, so nothing is kept.
- **N+1.** It also calls each list with a page of 5 and a page of 50 and
  compares the number of queries. The integration test
  `query-budget.integration.test.ts` does the same over HTTP for 6
  endpoints, on every `npm run test:integration`.
- **Frontend.** `npm run check:bundle` measures the first-load JavaScript
  (gzipped) for all 26 pages of the production build, and an e2e test counts
  the search requests sent while typing.

## Results

| Area | Result |
| --- | --- |
| Slowest query at 3-year volume | **15 ms** (order search). Everything else is under 10 ms; the budget is 150 ms. |
| N+1 queries | **None.** Every list uses the same number of queries for 5 rows as for 50. |
| Unbounded lists | **None.** Every list is capped: orders/users/ledger/activity ≤ 100, team status ≤ 50. An over-large `limit` is clamped or refused. |
| Unexpected full-table scans | **None** after the fixes below. The remaining full scans are shop-wide totals (dashboard counts, revenue, the unfiltered order count), where reading every row is the answer. Each one is listed with its reason. |
| JavaScript per page | 182–252 KB gzipped, **all within the 300 KB budget**. 168 KB of that is React plus the Next runtime, shared by every page. |
| Search boxes debounced | **All 5.** Details below. |

## What was found and fixed

| Problem | Effect at 3-year volume | Fix | After |
| --- | --- | --- | --- |
| **Team status loaded every staff member at once and filtered in the browser** | Grows with staff count; all rows sent on every visit | Search, role/status filter and pages of 20 are now done in the database. Counts come from the same query. | 1 query per page, 3–7 ms |
| Team status read **every order ever booked** to find the open ones | Grows every month, forever | Partial index `orders_open_created_idx` (open orders only), plus a `LATERAL … LIMIT 1` for each order's latest move | No full scans; cost follows the few hundred open orders, not history |
| "Last seen" read a person's whole audit history, then sorted it | Thousands of rows per busy person | Index `audit_log (actor_id, created_at desc)`, which replaces the old `actor_id` index | One index probe per row on the page |
| Staff report's weekly chart **rescanned the person's orders and history once per week** | 49,000 rows read, 31 ms | One grouped pass, starting from the month's delivery events (partial index `order_status_history_completed_idx`) | 0.5 ms, with no full scan. A new integration test proves the numbers are unchanged. |
| Staff report's person list loaded the whole team, with no search | Grows with the team; it also loaded designers before a team was even chosen | A searchable, debounced, 15-per-page picker served by the API | Loads only when a team is chosen |
| Orders and users search delayed **every** fetch by 250 ms, including page and filter clicks | Clicks felt slow | Only typing is debounced now (`useDebouncedValue`, 300 ms); clicks fetch immediately | — |
| The same pager markup was copied into 3 screens | A bug fix would be needed 3 times | Shared `components/ui/Pager.tsx`, used by 5 lists | — |
| Search input used as a raw `LIKE` pattern (team status) | "%" matched everyone | `containsPattern()` escapes `%`, `_` and `\` | — |

Two new migrations add these indexes: `20260925000001_reporting_indexes.sql` and
`20260925000002_completed_events_index.sql`. Both are applied **locally only**
and are on the production list for go-live. They only add or replace indexes,
so they are safe to apply before the code deploys.

## Search boxes (debouncing)

| Search | Debounced | Where it filters |
| --- | --- | --- |
| All Orders | ✅ 300 ms | Server (trigram indexes), paged |
| User Management | ✅ 300 ms | Server, paged |
| Reports → Team status | ✅ 300 ms | Server, paged |
| Reports → Staff report person picker | ✅ 300 ms | Server, paged |
| Product category picker | ✅ 200 ms | In memory: a fixed list of 43, so there's no server call |

The e2e test types 4 letters into Team status and checks that exactly **one**
request is sent.

## Frontend verdict

It's optimised for this app's needs. Pages are server components that load
data client-side, a page at a time. There are only 7 runtime dependencies.
Fonts are self-hosted via `next/font`. Photos are compressed on the phone
(≈ 6 MB → ≈ 300 KB) and lazy-loaded, and lists never load photos. Reports,
calendar months and activity days load only when opened.

## Recommendations (not done: each is a trade-off to decide)

1. ~~**Order lists sign photo URLs they never show.**~~ **Done, 25 Sep 2026.**
   `GET /orders` no longer loads image rows or signs their URLs (list items
   are `OrderListItem`, i.e. an `Order` without `images`). That saves an image
   query and one storage round trip per list load. `GET /orders/{id}` still
   returns signed image URLs. The query-budget test checks that list rows
   carry no images.
2. **Order search**: at 12k orders the planner prefers one scan (15 ms) over
   the trigram indexes. As the table grows, it switches to the indexes by
   itself. Nothing to do; the audit will show if that changes.
3. **Shop-wide dashboard totals** read every order, which is fine for years
   (5–11 ms at 3-year volume). If the shop ever reaches hundreds of thousands
   of orders, cache them for a minute.
4. **Designer/master-tailor dropdowns** (`/team-members`) load the whole active
   list. That's a few dozen people and fine; if the team grows past ~200, move
   those dropdowns to the searchable picker.
5. **Local test data**: RBAC and e2e runs leave fixture staff accounts in the
   local database (they show up in Team status). They're harmless locally and
   never touch production. A cleanup script would tidy them up.

## Repeat it

See the release checklist in `docs/engineering-practices.md` (API) and
`needleye-web/docs/engineering-practices.md` (web).
