# Release report — 25 Sep 2026

**Verdict: ready to release**, after the 5 database migrations below are
applied to production (API first, then web). Every automated check passes on
the final code. Four hidden bugs were found and fixed during this pass; one of
them would have stopped new orders from being created once a year reached its
1000th order.

## What was tested

| Area | Tool | Result |
| --- | --- | --- |
| API types, lint, build | `typecheck`, `lint`, `build` | ✅ |
| Business rules | 118 API unit tests | ✅ 118/118 |
| Real database behaviour, incl. no-N+1 query budget | 67 API integration tests | ✅ 67/67 |
| Who can do what (6 roles × endpoints) | RBAC matrix | ✅ 77/77 |
| Query speed at 3-year volume (12k orders, 360k audit rows, rolled back) | `npm run test:perf` | ✅ 32/32 within budget (incl. the new Kanban queries: 0.2 ms / 0.7 ms) |
| Security: auth, tampered tokens, headers, SQL injection, CORS, error hygiene | security scan | ✅ 14/14 |
| Brute-force protection on login | `npm run test:ratelimit` | ✅ blocked at attempt 16 |
| Web types, lint, production build | `tsc`, `eslint`, `next build` | ✅ |
| Web business rules (dates, money, calendar, categories, permissions) | 124 web unit tests | ✅ 124/124 |
| Page weight | `npm run check:bundle` | ✅ all 26 pages ≤ 300 KB (182–256 KB) |
| Browser end-to-end | Playwright, 26 tests | ✅ 26/26 |

The 26 browser tests cover:
- **Every role** (owner, designer, master tailor, accountant, production
  manager, worker) signs in and opens **every page** it can reach. The tests
  check there are no uncaught errors, no console errors, no 5xx responses and
  no error screens, and that restricted pages redirect.
- **Phone size:** the main pages don't scroll sideways.
- **Orders:** create an order with a photo, search, edit, record a payment,
  and fix the total after an edit.
- **Production:** change the stage with confirmation, then check it appears in
  Status History; the Kanban board (2-month window, 50 per page, paging).
- **Delivery calendar:** full-day warning, override and cancel.
- **Owner reports:** home cards, debounced search (one request per pause) and
  paging.
- **Staff accounts and printing:** User Management (create an account, then
  the one-time password), QR login for a worker, revenue CSV export, and the
  printable sticker.

## Bugs found and fixed in this pass

| # | Bug | Impact | Fix |
| --- | --- | --- | --- |
| 1 | **Order numbers broke at the 1000th order of a year.** The number was padded with `lpad(n, 3)`, which *cuts* longer numbers: #1000 became "…-100", a duplicate. | 🔴 **Critical.** Every new order failed from about April at 300 orders/month. | Migration `20260925000003`, plus a red→green test. |
| 2 | **Payments recorded between midnight and 05:30 IST got yesterday's date** (the server used UTC). | 🟠 On the 1st of a month, the payment was counted in the **previous month's revenue**. | Shop-timezone "today" (`common/time/business-date.ts`), with tests. |
| 3 | New orders' default booking date was yesterday between midnight and 05:30 IST (web and API). | 🟡 Wrong booking date on late-night orders. | The same helper; the web uses the local date. |
| 4 | Revenue and ledger reports' default date range was computed in UTC and mixed timezones. | 🟡 The range could be off by a day. | The same helper. |
| 5 | Grey (muted) text contrast was **2.97:1**, which fails the WCAG AA minimum of 4.5. | 🟡 Hard to read ("text not visible"). | Darker text tokens: now 4.71:1. |
| 6 | The Create account form's labels weren't linked to their inputs. | 🟡 Screen readers couldn't tell which label belongs to which field. | Labels linked (`FieldLabel htmlFor`). |

## What changed in this release (user-visible)

- **Batches A–E:**
  - QR login for more roles and a password show/hide toggle;
  - the new stage-permission rules and the Dyeing stage;
  - 47 product categories in a searchable picker;
  - the delivery calendar with capacity warnings;
  - owner-only Reports (team status, staff report, daily activity).
- **Categories:**
  - the label now reads "Divided Skirt";
  - Custom entries added for Upper Body, Lower Body and Mens Wear, plus Mens
    "Skirt";
  - repeated names now show their collection, e.g. "Shirt (Mens Wear)".
- **Performance:**
  - server-side paging and debounced search everywhere;
  - order lists no longer load or sign photos;
  - 3 new indexes;
  - the staff report's weekly chart went from 31 ms to 0.5 ms.
- **Design:**
  - the logo palette (burgundy, sand, gold);
  - Playfair Display and Plus Jakarta Sans, with readable figures;
  - Lucide icons;
  - subtle motion;
  - a burgundy order hero and revenue band;
  - richer order-page cards.
  - The layout and all data are unchanged.
- **Kanban:** shows only orders booked in the **last 2 months**, **50 per
  page** with Prev/Next (server-side: `GET /orders?createdFrom=…&limit=50`),
  with a note giving the start date. Table view still shows every order.
- **Dashboard delivery calendar** (owner and production manager): the order
  form's calendar in browse mode. It reaches 3 months back and 6 ahead; click
  any day to list that day's orders (`GET /orders?dueOn=`) and open one.
- **Removed:** the Staff Report button on All Orders. It's reachable from
  Reports.
- **Removed:** the "View only — this order isn't assigned to you" notice on
  the order page. The rules behind it are unchanged: people outside the order
  still can't see payments or change status, and the server still enforces
  that. The smoke e2e now checks the notice never shows.

## Production steps (in this order, when you're ready)

1. **Commit** both repos (nothing is committed yet).
2. **Database.** From `needleye-api`, run
   `npx supabase@2.117.0 db push --dry-run`, check that exactly these 5 are
   listed, then run `db push`:
   - `20260924000001_order_status_dyeing.sql`
   - `20260924000002_drop_product_category_check.sql`
   - `20260925000001_reporting_indexes.sql`
   - `20260925000002_completed_events_index.sql`
   - `20260925000003_order_number_beyond_999.sql` (**critical**)

   All five only loosen rules, add indexes or fix a function, so they're
   safe to apply before the code.
3. **Railway (API).** The optional variables are `DELIVERY_DAY_CAPACITY` (default
   10) and `BUSINESS_TIMEZONE` (default Asia/Kolkata). Leave both unset unless
   you need other values. Keep `TRUST_PROXY=2`. Deploy.
4. **Vercel (web).** Deploy after the API is live.
5. **Smoke test on production:** sign in as owner, open an order, then check
   Reports and the delivery calendar. Run
   `npm run test:ratelimit -- --base=https://<api>/api/v1`.

## Known items (not blocking)

- **Form labels** on the other forms (30 of 33) still aren't linked to their
  inputs. It's an accessibility improvement; the pattern is ready
  (`FieldLabel htmlFor`).
- **Order-number year** uses the database clock (UTC). Orders placed between
  00:00 and 05:30 IST on 1 January get the old year in their number. It's
  cosmetic; numbers stay unique.
- **Load test** (60 concurrent users) wasn't re-run in this pass. It needs a
  second API instance started against a throwaway database (see
  `scripts/scale-test/README.md`). Say the word and I'll run it.
- **Local test data:** automated runs leave test accounts and orders in the
  *local* database only. That doesn't affect production.
