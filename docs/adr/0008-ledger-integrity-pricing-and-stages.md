# 0008: Ledger integrity -- pricing rules, payment rules, split audit logs, ledger totals, and the Ready / Marking stages

## Status

Accepted (2026-10-08). Built on branch `feature/ledger-integrity` in both repos,
in five phases, each tested and shown to the owner before the next. Every
decision below was made with the owner in conversation; this file is the record.
Production rollout happens only when the owner asks (see "Rollout").

| Phase | Scope | State |
|---|---|---|
| 1 | Marking and Ready stages; Alteration <-> Ready loop; Delivered only from Ready; dashboard cards | built |
| 2 | Pricing and payment rules (orders without a price, raise / discount, locks) + price history | built |
| 3 | Separate payment and order audit logs, daily-activity categories | built |
| 4 | Ledger daily totals, calendar months, Revenue page cards + paged month table + export | built |
| 5 | Nightly reconciliation, closing the books | built |
| 6 | Amendment (2026-10-09): price corrections, delivery locks nothing, the books lock orders too | built |

**Amended 2026-10-09 by the owner** -- see "Amendment: simpler price rules"
at the end. Where an earlier section says raise / discount, or that delivery
locks the price or the payments, the amendment wins. A proposed customer-credit
/ refund feature was built and then dropped by the owner the same day (the
code is kept in a git stash, not in the tree).

## Context

The Revenue page and the ledger have to be numbers the owner can trust and that
can't silently change. A review of the current code found:

- **Audit rows are best-effort:** written after the change, outside its
  transaction, so a crash between the two loses the audit row.
- **Payments are hard-deleted,** and `order.updated` audit rows don't carry the
  before/after values, so a changed total can't be reconstructed.
- **Past months can be edited:** a back-dated or edited payment changes a month
  that was already reported.
- **`payments.order_id` cascades on delete:** deleting an order deletes its
  money history.
- **`payment.created` audit rows lack `paidAt`,** and `paidAt` itself isn't
  validated (future dates are accepted).
- **The revenue month is shifted by `ACCOUNTING_CYCLE_START_DAY`** (day 7 in
  production), so "October" didn't mean the calendar month.
- The dashboard's **"Completed" card counts every delivered order ever**, and
  there was no "ready, waiting for the customer" stage.

## Decisions -- production stages (phase 1)

1. **Two new stages.** **Marking** (between Dyeing and Cutting) and **Ready**
   (after Quality Check / Trail). The flow is now 16 stages:

   `Design Pending -> Design Approved -> PM Received -> Falls / Kutchu ->
   Fabric Purchased -> Dyeing -> Marking -> Cutting -> Stitching -> Hand Work ->
   Machine Work -> Finishing -> Quality Check / Trail -> Alteration -> Ready ->
   Delivered`

2. **Alteration is a side loop around Ready.** The main path is
   `QC / Trail -> Ready -> Delivered`. An order can go **Ready -> Alteration ->
   Ready** as many times as needed (the customer tries it, it needs a change).
   **Ready -> Alteration is the only backwards move in the whole flow**; every
   other move is still forward-only. QC -> Alteration is also allowed (the trail
   showed a problem). Alteration sits *before* Ready in the stage order so the
   board columns and the order tracker read Ready right before Delivered.
3. **Delivered only from Ready.** Any other stage -> Delivered is refused
   (`409 ORDER_DELIVER_REQUIRES_READY`), including Alteration -> Delivered. It is
   enforced by the API inside the row-locked status transaction **and** by a
   database trigger (`orders_guard_stage_change`), so no other path can skip it.
4. **Who can set them.** Marking is a floor stage (production tier, same as
   Dyeing and Cutting: owner, designer, PM, master tailor, worker). Ready is a
   finalization stage (same as QC and Alteration: owner, designer, PM).
5. **Scans advance along the main path.** The QR-scan prompt offers the next
   *main-path* stage: QC -> Ready, Alteration -> Ready, Ready -> Delivered. It
   never suggests Alteration; that is a deliberate choice from the status menu.
6. **Existing orders keep their stage.** An order already in QC or Alteration
   goes through Ready before it can be delivered. No data is rewritten.

### Dashboard cards (phase 1, + one in phase 2)

- **"Completed" (all-time) is replaced by "Delivered this month"**: orders that
  reached Delivered since the 1st of this month in the shop's timezone (by their
  stage-history row), not every delivered order ever.
- **"Ready for delivery"**: orders currently in Ready.
- **"Price not set"** arrives with phase 2, when an order can exist without a
  price.

## Decisions -- pricing (phase 2)

1. **New orders have no price.** The order form no longer asks for the total.
   After an order is saved, a popup asks **"Add pricing now?"**: total first,
   then payments and the next payment date. An order without a price shows
   **"Price not set"**, has its own dashboard card and filter, takes **no
   payments**, and **can't be delivered** (popup: "Set the order total first").
   `orders.total_amount` becomes nullable; `payment_status` gains `not_priced`.
2. **The double-check alert.** When a total is typed, an animated alert shows:
   > Please be double sure this total is correct: **Rs X (amount in words)**. The
   > total can be raised (with a reason) or lowered only as a discount, by the
   > Owner or Accountant, never below what's already been collected. Once the
   > order is delivered, the price is locked.
3. **Setting the first price:** the assigned designer, Owner or Accountant.
4. **Raising the price:** Owner or Accountant only, **reason required**.
   (Designers set the first price but can't change it afterwards.)
5. **Lowering the price = a discount:** Owner or Accountant only, reason
   required, recorded as a discount given to the customer. **Never below what's
   already been collected**, and no payment is ever removed to make room.
6. **Delivered locks the price.** No raise or discount after delivery.
7. **Rs 0 stays intentional.** A Rs 0 total is a free order and is fully paid
   (as decided on 2026-10-05).

## Decisions -- payments (phase 2)

1. **Recording:** designers (their own orders), Owner and Accountant -- before or
   after delivery, but only once the order is priced.
2. **Editing or deleting:** Owner and Accountant only, **only before delivery**
   and **only in an open month**.
3. **After delivery, payments are immutable** -- nobody can edit or delete them.
   The owner accepted that a mistake noticed after delivery stays (an
   under-recorded amount can still be topped up by recording another payment).
4. **Payment date:** a real calendar date, not in the future, not in a closed
   month.
5. **`payments.order_id` becomes `ON DELETE RESTRICT`** (was CASCADE): an order
   with payments can't be deleted, so money history can't vanish with it.

### How phase 2 is built

- **One pricing endpoint, the server decides the kind.** `PUT /orders/:id/price
  { totalAmount, reason? }`: no price yet -> `set`; higher -> `raise`; lower ->
  `discount` (same total -> 400). The rules live in `order-pricing.rules.ts`
  (`decidePriceChange`) and run against the order row LOCKED in the same
  transaction that writes the total, the re-derived payment status and the
  price-history row -- a payment locks the same row, so "collected" can't change
  underneath. A discount down to exactly what's collected settles the order.
- **Price history moved into phase 2.** The reason for a raise or a discount has
  to be stored the moment it happens, so `order_price_history` (kind, previous
  and new total, collected, reason, who, when; append-only by trigger) ships with
  the pricing rules instead of with the phase 3 logs. A total given at booking is
  recorded as the first `set`.
- **An edit can't change the price.** `PATCH /orders/:id` may resend the
  current total unchanged (edit forms send every field); any other value is
  `400 ORDER_PRICE_USE_PRICING`. The order form has no price field at all.
- **`priceSet` for every role.** The amount stays hidden from the PM, master
  tailor and worker, but whether an order is priced is not sensitive, so the
  status menu, Kanban and scan prompt can say "Set the order total first" before
  trying.
- **Capabilities.** `orders:edit:total` is replaced by `orders:price:set`
  (owner, accountant, the order's own designer) and `orders:price:adjust`
  (owner, accountant). `payments:manage` now means *record*; the new
  `payments:correct` (owner, accountant) gates editing and deleting --
  designers can no longer remove a payment they recorded.
- **Database guards** (migration `20261009000001`): Delivered needs a price;
  no price change once delivered; a price can't be removed or set below the
  payments; no payment on an unpriced order; payments never sum past the total;
  no payment edit/delete once delivered; `payments.order_id ON DELETE RESTRICT`;
  `orders_price_status_consistent` (no total <=> `not_priced`). Integration
  fixtures delete payment rows with `session_replication_role = replica`,
  which the local test role may set and the production runtime role can't.
- **Payment date.** The API refuses a `paidAt` after the shop's today
  (`PAYMENT_DATE_INVALID`) or that isn't a real date. The web records payments
  dated today, as before. Since phase 5, it also can't be in a closed month.

## Decisions -- audit logs (phase 3)

1. **Separate, typed logs**, append-only, written **in the same transaction** as
   the change (no more best-effort audit for money):
   - `payment_audit_log` -- every payment create / edit / delete with typed
     amount, method, paid-at date and notes, and the previous values for an edit
     (no separate reason: corrections are already limited to the Owner and
     Accountant, before delivery);
   - `order_audit_log` -- order create / edit with the changed fields' before and
     after values;
   - `order_price_history` -- built in phase 2 (see above);
   - `order_status_history` is reused (it's already separate) and gains
     `from_status`;
   - `audit_log` keeps sign-ins, QR and account events.
2. **Daily activity in categories.** Reports -> Daily activity gets tabs with
   counts: **Orders** (created, edited, pricing), **Stages**, **Payments**,
   **Leads**, **Sign-ins & accounts**. Each tab is filtered and paged by the API;
   nothing loads every row at once.

### How phase 3 is built

- **Same transaction, every time.** `DrizzlePaymentsRepository` writes the
  payment_audit_log row inside the order-locked transaction that records /
  edits / removes the payment; `DrizzleOrdersRepository` writes order_audit_log
  inside create / edit / image removal, and `from_status` with every stage
  move. The services no longer write order or payment events to `audit_log`.
- **An edit records only what changed.** The edit transaction locks the order
  row first (that also checks the optimistic-lock version and reads the current
  due date for the capacity rule), then `diffOrderFields` compares the
  submitted fields with it: blank and null are the same, unchanged fields are
  dropped, and a save that changes nothing writes no row. A designer / master
  tailor change also stores both names.
- **A full-day delivery override** is no longer a separate event: the capacity
  guard returns it and it is stored on the create / edit row
  (`details.deliveryOverride`).
- **Append-only, enforced by the database**: a trigger refuses updates and
  deletes on both logs, except a cascade from deleting the parent order (the
  app never deletes orders) or an account (actor_id set to null).
- **History copied, nothing deleted.** Migration `20261010000001` copied the
  content of the older `order.*` / `payment.*` audit_log rows into the new logs
  (a delivery override joins its create / edit row by request id; the earliest
  "payment removed" rows, which carried no amount, take it from that payment's
  previous row) and filled `from_status` from each order's previous history
  row. The audit_log originals stay where they are.
- **"Last seen"** on the team status page is the latest row in ANY log -- one
  indexed top-1 probe per log -- since order and payment actions no longer
  reach audit_log.
- **Ledger Activity** reads payment_audit_log and now shows each payment's
  paid-on date (also a CSV column).

## Decisions -- ledger totals and the Revenue page (phase 4)

1. **Calendar months, always.** Revenue months start on the 1st; the
   `ACCOUNTING_CYCLE_START_DAY` setting is removed.
2. **Each month shows four numbers:**

   | Card | Meaning |
   |---|---|
   | Total | value of orders **booked** that month |
   | Paid so far | how much of *those* orders has been paid, up to today |
   | Outstanding | Total - Paid so far (unpaid on that month's orders) |
   | Cash collected | all money **received** that month, from any order |

   Outstanding keeps shrinking as that month's customers pay later; closing a
   month freezes its *cash collected*, not its Outstanding.
3. **`ledger_daily`**, one row per shop day, kept by database triggers on
   orders and payments, so the Revenue page reads a few hundred small rows
   instead of summing every payment.
4. **Revenue page:** this month's cards, a **paged month table** for any range
   (e.g. January 2020 to now) with range totals calculated by the API, and
   **CSV and PDF export** of the chosen range. It replaces the unpaged *Monthly
   Revenue History* table.

### How phase 4 is built

- **Days, not months, in the table.** `ledger_daily` holds one row per shop day
  (booking_date and paid_at are shop days already); months are sums of days,
  so any range is a primary-key range read -- the speed audit measures a
  240-month export at about 5 ms over 3 years of synthetic data.
- **Booked by `booking_date`**, the order's business date (editable). Moving it
  moves the order -- its value and what's been paid on it -- to the new day.
  Pricing an order later raises its booking month's total then: Total is "the
  orders booked that month, as priced now".
- **Kept by the database, not the app.** Triggers on orders and payments apply
  each change as a delta in the change's own transaction, locking the touched
  days in date order. They are `SECURITY DEFINER` with no app write grant, so
  totals move only through orders and payments, and `ENABLE ALWAYS` so even a
  replica-mode session (the test cleanup) can't make them drift. An upsert is
  not used: Postgres checks the table's "never negative" constraints against
  the proposed (delta) row of an upsert, so missing days are created as zeros
  and the deltas applied as an update -- the checks then judge the totals.
- **No drift from the backfill:** the migration creates the triggers first
  (which locks orders and payments against writes until commit) and then
  backfills, in one transaction.
- **API:** a new `ledger` module -- `GET /ledger/summary`, `GET /ledger/months`
  (newest first, default 12 a page, max 60, zero-filled, with the whole range's
  totals), `GET /ledger/months/export` (at most 240 months). The old
  `GET /orders/revenue` and `ACCOUNTING_CYCLE_START_DAY` are removed.
- Found on the way: an order / payment / user id that isn't a UUID answered
  **500** (Postgres refused the uuid cast). Those routes now check the id first
  and answer 404.

## Decisions -- verification and closing the books (phase 5)

1. **Nightly reconciliation** at 02:00 shop time recomputes the ledger totals
   from the raw orders and payments and stores the result; the Revenue page
   shows "verified" (or what didn't match). **Verify now** runs the same check
   on demand. It runs inside the database (pg_cron) -- no separate server.
2. **Closing the books:** Owner or Accountant closes a month that has ended;
   only the Owner reopens it, with a reason. A closed month accepts no new,
   edited or deleted payments dated inside it.
3. **A closing record.** Each close stores the month's figures at that moment
   in a separate, append-only table; every close and reopen is kept, with who
   and when (and the reopen's reason).
4. **Closing freezes cash collected, not Outstanding.** The month's Total,
   Paid so far and Outstanding keep following its orders (a discount, a later
   payment dated in an open month); its cash collected and payment count can't
   change while closed.
5. **Nothing moves or is deleted.** A closed month keeps its daily register
   rows (a few hundred small rows a year); the check covers every day,
   including closed months, and also confirms each closed month still holds the
   cash it was closed with.

### How phase 5 is built

- **Migration `20261012000001`**: `ledger_month_closings` (append-only; a
  close carries orders booked / priced, total, paid so far, cash collected and
  payment count; a reopen needs a reason), `ledger_reconciliations` (one row
  per check, written only by the check), the payments guard, the check
  function, and the nightly job.
- **A month is closed when its latest close/reopen row says "closed"**
  (`ledger_month_closed()`), so a reopen never deletes anything.
- **A close and a payment can't cross.** Each calendar month has an advisory
  lock (4203, year*12 + month). Closing takes it exclusively: it waits for
  payment changes already in flight in that month, then reads the month's
  figures (so the record includes them). A payment change takes it shared for
  each month it touches -- the old date and the new one -- then checks the
  month is open (a separate statement, so it sees a close that committed while
  it waited) and answers **409 `PAYMENT_MONTH_CLOSED`** if not. The database
  trigger `payments_closed_month_guard` takes the same lock and re-checks, so
  even a direct SQL write can't change a closed month's payments.
- **The check** (`ledger_reconcile()`, `SECURITY DEFINER`) recounts every
  day from orders and payments and compares with `ledger_daily` (up to 50
  mismatched days kept, with register vs actual per field); counts orders paid
  past their total and orders whose payment status doesn't match their
  payments; and compares each closed month's cash and payment count with its
  closing record. It only reads, apart from its own result row. One check at a
  time (try-lock 4204): a second "Verify now" meanwhile answers **409
  `LEDGER_CHECK_RUNNING`**. The speed audit measures it at about 32 ms over 3
  years of synthetic data.
- **Nightly:** pg_cron job `needleye-ledger-reconcile`, `30 20 * * *` UTC =
  02:00 IST. The Revenue page warns when the last nightly check is over 26
  hours old.
- **Who can call the functions.** Postgres lets everyone execute a new
  function and Supabase serves public functions over its REST API, so the
  migration revokes EXECUTE on `ledger_apply` (phase 4: only the ledger
  triggers call it), `ledger_reconcile` and `ledger_month_closed` from
  PUBLIC / anon / authenticated / service_role, and grants the last two to the
  app role.
- **API:** `GET /ledger/months/:month/closings`, `POST
  /ledger/months/:month/close` (`ledger:close`: Owner, Accountant), `POST
  /ledger/months/:month/reopen` (`ledger:reopen`: Owner; body `{reason}`),
  `GET /ledger/reconciliations/latest`, `POST /ledger/reconciliations`. Each
  month in `/ledger/months` and the export carries its `books`; each payment
  carries `monthClosed`.
- **Web:** a books-check bar with Verify now on the Revenue page; a Books
  column (Closed / Close... / Running) opening one dialog that shows the
  figures now, the closing record beside them, the history, and Close or
  Reopen; payments in a closed month show "Month closed" instead of Remove;
  the CSV gains a Books column and the PDF marks closed months.

## Amendment: simpler price rules (2026-10-09)

The owner simplified pricing and moved every lock to the books:

1. **One kind of change after the first price: a correction.** Up or down, by
   the Owner or the Accountant, with a reason (3-500 characters).
   `order_price_history.kind` is `set` or `correction`; older rows keep
   `raise` / `discount` and read as corrections. There is no discount or
   refund feature.
2. **Never below what's been collected.** To lower a price further, first
   correct or remove the payment that's wrong, then correct the price. The
   message says so (`ORDER_TOTAL_BELOW_PAID`).
3. **Delivery locks nothing.** A delivered order's price can be corrected and
   its payments edited or removed. Delivered still needs a price.
4. **The books are the lock.**
   - A payment dated in a closed month can't be added, changed or removed
     (unchanged since phase 5).
   - An order booked in a closed month can't be repriced
     (`ORDER_PRICE_MONTH_CLOSED`), and no order can be booked into, or moved
     out of, a closed month (`ORDER_BOOKING_MONTH_CLOSED`). The API checks
     under the month's shared lock (4203); the trigger
     `orders_closed_month_guard` refuses the same writes underneath.
   - A month can't be closed while one of its orders has no price
     (`LEDGER_MONTH_HAS_UNPRICED`) -- otherwise that order could never be priced,
     so never delivered. Price it, then close.
   - So a closed month's booked orders and total are frozen as well as its
     cash; the nightly check now compares all four with the closing record.
     "Paid so far" on those orders can still grow (a customer paying later, in an
     open month) -- that isn't drift.
5. **The orders list** gains filters: stage, timeline (overdue / urgent /
   due soon / on track / delivered) and booking year / month (indexed on
   `booking_date`). **The new-order form** gets "Fetch customer details":
   on a button press (never while typing), the newest orders with that exact
   phone (indexed on `phone, created_at`); the user picks one and its customer
   name is filled in.

Migration: `20261013000001_price_corrections_and_books.sql` (additive: a wider
kind check, replaced guard functions, one new trigger, two indexes, the check
function replaced).

## Rollout (production, only when the owner asks)

1. Back up the production database.
2. Rehearse the migrations on a copy of production data.
3. Additive migrations with before/after count checks and a temporary bridge
   trigger, so the running app keeps working during the deploy.
4. Deploy the API, then the website.
5. Run reconciliation; it must come back all verified.
6. A cleanup migration in the next release removes the bridge.

## Consequences

- The Kanban board gains two columns, and the order tracker two nodes.
- Every test, seed and fixture that set an order straight to `delivered` now
  goes through `ready` first (the database refuses anything else).
- Earlier ADRs are superseded where they disagree: ADR 0005's "forward-only, no
  exceptions" now has one exception (Ready -> Alteration), and its stage list
  grows from 14 to 16.
