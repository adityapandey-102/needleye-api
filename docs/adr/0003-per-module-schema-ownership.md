# 0003: Each module owns its own Drizzle schema; cross-module reads stay Infrastructure-to-Infrastructure only

## Status

Accepted, and complete (2026-07-23). Every table now lives in its owning module's `infrastructure/*.schema.ts`: `payments` (Payments), `profiles` (Users), `qr_login_tokens` (Auth), `orders`/`order_images`/`order_counters` (Orders, plus a separate `order.relations.ts` per that module's explicit file-naming convention). The shared `common/database/schema.ts` has been deleted -- its responsibility shrank to zero exactly as this ADR anticipated.

## Context

`common/database/schema.ts` held every table in the application -- `profiles`, `qr_login_tokens`, `order_counters`, `orders`, `order_images`, `payments` -- owned by no single module, growing without bound as features were added. This is the textbook "god file": every module change risked touching a file every other module also depended on.

Splitting schema per module runs into a real cross-cutting problem immediately: `payments` needs to read `orders.designer_id`/`total_amount`/`payment_status` to enforce access rules and the ledger invariant; `orders` needs to sum `payments.amount` to compute `amountPaid`/`outstanding`. Neither of these is optional -- they're existing, load-bearing reads, not new coupling being introduced.

## Decision

Each module owns the Drizzle table definitions for the tables it's the business owner of, in `modules/<name>/infrastructure/<name>.schema.ts`. `common/database/drizzle-client.ts` aggregates every module's schema file (plus whatever's left in the shared `schema.ts`) into the one object Drizzle needs to build its client and relational query API against -- this aggregation point is explicitly "Infrastructure bootstrap," an allowed Shared/common concern, not business logic.

Cross-module reads of another module's owned table are permitted **only from one Infrastructure adapter's file into another module's schema file** -- e.g. `drizzle-orders.repository.ts` imports `payments` from `modules/payments/infrastructure/payments.schema.ts` to run its `SUM()` aggregate; `drizzle-payments.repository.ts` imports `orders` from `modules/orders/infrastructure/order.schema.ts` and `profiles` from `modules/users/infrastructure/profile.schema.ts` for its read-only `findOrderContext`. Neither module imports the other's `application/` or `domain/` layer, ever, for this or any other reason.

One direct consequence of that last rule: Orders and Payments both enforce the same underlying invariant -- a fully-paid order's ledger sum must equal its total -- from opposite sides (`orders/domain/order-ledger.rules.ts`'s `assertOrderCanBeMarkedFullyPaid` when the order is marked fully paid; `payments/domain/payment-ledger.rules.ts`'s `assertLedgerReconciles` when a ledger entry is added/edited/deleted while already fully paid). These are two small, independent copies of the same rounding-and-comparison logic, not one shared function, because sharing it would mean one module's Domain layer importing the other's -- exactly what this ADR prohibits. A few lines of duplicated arithmetic was judged cheaper than a Domain-to-Domain coupling between modules that are supposed to be independently understandable and independently changeable.

Duplicating the table definition per consumer was considered and rejected: two Drizzle schema objects mapping to the same physical table are a drift risk with nothing to catch them diverging, worse than the coupling being avoided.

## Consequences

- Module boundaries are enforced at the Application/Domain layers, where the real business-logic isolation value is. Infrastructure retains a small, explicit, documented set of cross-module read dependencies for aggregate queries that would otherwise require either duplicating live business tables or replacing a single SQL `JOIN`/`SUM()` with multiple round-trip queries -- the latter would directly violate this project's own N+1/round-trip-minimization requirement.
- Every cross-module Infrastructure import is commented at the import site, pointing back to this ADR, so it reads as a deliberate, reviewed exception rather than an accidental dependency.
- `fetchActiveProfile` (`common/database/profiles.ts`, used by `requireAuth`) and Orders' designer/master-tailor name joins (`order.relations.ts`) both got the same treatment as every other cross-module read: an Infrastructure-to-Infrastructure schema import, documented at the call site, nothing deeper.
- A module's Domain layer never imports another module's Domain layer, even when two modules independently need the same small invariant (see the fully-paid reconciliation example above) -- a little duplication at that layer is the accepted cost of keeping modules independently reasoned-about.
