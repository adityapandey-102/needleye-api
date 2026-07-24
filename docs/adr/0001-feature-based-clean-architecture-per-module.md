# 0001: Feature-Based Modular Monolith with Clean Architecture per module

## Status

Accepted, and complete (2026-07-23). All five modules converted in order, smallest/lowest-risk first: `payments`, `team-members`, `users`, `auth`, `orders` (the largest, converted last). Each was verified live against the running stack before the next one started; no module was ever left partially migrated.

## Context

The codebase was already a Modular Monolith (`src/modules/*`, one deployable process, enforced internal layering per module). That layering was flat: controller → validation → service → repository → mapper, all as sibling files in one folder, with the repository file holding both the persistence contract (interface) and its concrete Drizzle implementation together.

This produced two real problems as the codebase grew:
- No pure Domain layer existed. Business rules (e.g. the payment ledger's fully-paid reconciliation invariant) lived inline inside service methods, mixed with orchestration and repository calls -- untestable in isolation from Drizzle/Express, and not something a reader could point to as "the rule," only "the code that happens to enforce it."
- Repository files mixed the abstraction (interface) with the adapter (concrete class) in one file, so nothing in the file structure signalled which part was stable and which was swappable.

## Decision

Each module gets four sub-folders, dependencies pointing inward:

```
modules/<name>/
  api/            controllers (*.routes.ts), request/response DTOs, presenters (entity -> DTO)
  application/    use-case orchestration (*.service.ts), repository ports (interfaces)
  domain/         entities/value objects, pure business-rule functions -- zero framework/persistence knowledge
  infrastructure/ concrete adapters (Drizzle repository, this module's schema.ts, persistence mappers)
```

Rules:
- **Domain depends on nothing.** No imports from `application/`, `infrastructure/`, `express`, or `drizzle-orm`.
- **Application depends on Domain** (calls domain rule functions, constructs/reads domain entities) **and declares the ports** Infrastructure must satisfy. Never imports Drizzle or any concrete adapter.
- **Infrastructure depends on Domain and Application's ports** -- implements the port, maps persistence rows to domain entities.
- **API depends on Application** -- controllers call service methods only, never touch a repository or Drizzle directly.

## Consequences

- More files per module than the flat layout (a `payments` module went from 5 files to 12). Accepted deliberately: this project's own stated principle from an earlier reset is "consistency across the codebase matters more than trimming file count," and the same reasoning applies here -- every module gets the same shape regardless of size, rather than special-casing small ones.
- A genuine trade-off surfaced converting `team-members` next (see the Phase 2 plan in the README): a module with almost no business rules will have a near-empty `domain/` folder. That's fine -- an empty domain layer for a CRUD-shaped lookup module is honest, not a sign the pattern doesn't fit; forcing invented "rules" into it to look busier would be the actual overengineering.
- Cross-module references are sometimes unavoidable (Payments needs to know an order's designer/total/status; Orders needs to sum Payments' ledger). See ADR 0003 for exactly which layer is allowed to do this and why.
