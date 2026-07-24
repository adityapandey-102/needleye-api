# 0002: Split repository contracts from implementations; domain rules throw the app's one error type

## Status

Accepted. Applied to every module (`payments`, `team-members`, `users`, `auth`, `orders`) by 2026-07-23 -- `payments` was the template. Orders' port additionally replaced its old snake_case `Record<string, unknown>` update parameter with a fully typed `UpdateOrderRecord`/`NewOrderRecord` (matching the DTO's own camelCase field names), retiring a `FIELD_TO_COLUMN` translation table that a properly typed port made unnecessary.

## Context

Every repository used to be one file: an exported `interface XRepository` immediately followed by `class DrizzleXRepository implements XRepository`. That made two things impossible to see from the file tree alone: which part of the module was the stable contract the Application layer actually depends on, and which part was the swappable adapter. Adding a second implementation (a test double, a cached reader, a future read-replica-backed variant) meant editing the one file that also defines the interface everything else depends on.

A related question came up while extracting `payment-ledger.rules.ts`: should the pure domain rule function (`assertLedgerReconciles`) throw a dedicated "domain error" type, translated to an HTTP `AppError` somewhere in Application/API? Strict Clean Architecture says Domain shouldn't know about delivery-mechanism concerns (an HTTP status code baked into the exception is exactly that).

## Decision

**Port/implementation split**: the interface moves to `application/ports/<name>-repository.port.ts`; the concrete class moves to `infrastructure/drizzle-<name>.repository.ts`. The port is expressed in domain-shaped types (`PaymentEntity`, `NewPaymentRecord`, `UpdatePaymentRecord` -- all camelCase, all typed), not raw persistence rows. Only the Infrastructure adapter is allowed to import Drizzle.

**Domain errors**: domain rule functions throw this codebase's existing `AppError` subclasses (e.g. `ConflictError`) directly, rather than a parallel domain-error hierarchy with a translation layer. This is a deliberate choice, not an oversight: this API has exactly one delivery mechanism (Express REST) and will not gain a second one in its planned lifetime. A translation layer earns its cost when there's a real second consumer (a gRPC service, a CLI, a background job) that needs a different error shape from the same domain rule -- speculating that need now would be exactly the "unnecessary abstraction that provides no practical value" this project's own instructions warn against.

## Consequences

- `UpdatePaymentRecord` (a properly typed port parameter) replaced what used to be a stringly-typed `Record<string, unknown>` with hand-translated snake_case keys passed from the service into the repository. That ad hoc translation still happens, but now only inside the Infrastructure adapter (mapping `UpdatePaymentRecord`'s camelCase fields to Drizzle column values) -- a smaller, more honest place for it than a loosely-typed service→repository boundary.
- Adding a second `PaymentsRepositoryPort` implementation (for a test, a cache, anything else) never touches `application/` or `domain/`.
- If this API ever does grow a second delivery mechanism, the fix is additive (introduce a domain-error type and translate it at each delivery mechanism's boundary) rather than a rewrite -- the port/service structure doesn't have to change to support it later.
