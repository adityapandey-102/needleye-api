# 0004: Operational hardening — request context, error codes, audit, rate limiting, optimistic locking

## Status

Accepted, and complete (2026-07-27). Implemented as one hardening pass. No business behaviour changed; no API contract changed except additive fields (`requestId` on error bodies, `version` on orders / the order-update request).

## Context

The application was functionally complete and well-tested, but not yet operationally hardened for long-term production use: logs couldn't correlate a user report to a request, error responses carried only generic HTTP-shaped codes, there was no business audit trail, no brute-force protection, no protection against concurrent-edit clobbering, no slow-query visibility, and the app connected as a DB superuser. This ADR records the patterns chosen and — importantly — **how to extend each**, so future work stays consistent.

## Decisions and extension points

- **Request context via AsyncLocalStorage** (`common/context/`). One `requestId` (plus `userId`/`role` after auth) is carried implicitly through the async call stack, so code with no `req` (the audit and slow-query loggers) can still correlate to the request. *Extend:* add a field to `RequestContext` and set it in the middleware; readers pick it up automatically. AsyncLocalStorage is a Node built-in — not a tracing framework, and deliberately not OpenTelemetry (out of scope at this scale).

- **Single error path + stable error-code registry** (`common/errors/`). `error.middleware.ts` is the only place an error becomes a response *and* the only place errors are logged (no log-and-rethrow), always with `{ error, code, details?, requestId }`. `ERROR_CODES` is the one registry; clients branch on `code`, never the message. *Extend:* add the code to the registry, then pass it at the throw site (`new NotFoundError("...", ERROR_CODES.X)`). Never inline a literal.

- **Audit logging behind an interface** (`common/audit/`). `AuditLogger` is the seam; `DrizzleAuditLogger` writes to `audit_log`, filling actor/request-id from context, and **never throws** (a failed audit write is logged and swallowed). Business services depend on the interface and record actions from the Application layer (the right altitude — where a business action *is*). *Extend:* add an action to `AUDIT_ACTIONS`, call `audit.record(...)` from the service; to change the sink, write one new class implementing `AuditLogger`. No DB table read-path is exposed — `audit_log` has no anon/authenticated grant.

- **Auth rate limiting isolated behind middleware** (`common/middleware/rate-limit.middleware.ts`, `express-rate-limit`, in-memory). Applied only to `/auth/*`. In-memory is correct for a single-process monolith; **no Redis**. *Extend/scale:* if this ever runs multi-instance, add a `store:` in that one module — nothing else changes.

- **Optimistic locking via a `version` column, not `updated_at`** (`orders.version`). A dedicated integer avoids timestamp-precision round-tripping between Postgres and JS. The repository always bumps it and, when the client supplies the loaded version, guards the write on it, rejecting a stale edit with `409 ORDER_MODIFIED` rather than clobbering. Chosen over pessimistic locking (no held DB locks across a user's think-time). *Extend:* apply the same pattern (return `version`, echo it, guard the update) to any other independently-editable record.

- **Slow-query visibility, not auto-optimization** (`common/database/query-timing.ts`). The pool is wrapped to log statements over `SLOW_QUERY_MS`; parameter values are never logged. It only surfaces problems for a human to judge — it never rewrites a query.

- **Least-privilege runtime DB role** (`docs/least-privilege-db-role.sql`, a documented one-time admin script, not an auto-run migration). Separates runtime credentials (the app: data access only, `needleye_app`) from migration credentials (an owner/CLI connection). Keeps `BYPASSRLS` on purpose — the app connects directly to Postgres and enforces authz at the application layer, exactly as Supabase's `service_role` does; RLS stays on as defense-in-depth for the Data-API path the app never uses.

- **Refresh token in an httpOnly cookie** (frontend). Because JS can't set an httpOnly cookie, session establishment/rotation/clearing moved to same-origin Next.js route handlers (`app/api/session/*`) that set the cookies server-side. The access token stays JS-readable (short-lived, needed for the Bearer header). Documented fully in needleye-web's README.

## Consequences

- One `requestId` now ties together a request's access log, every application log during it, its slow-query logs, its audit records, and the error response body — the core operational-diagnostics win.
- The API contract gained only additive, backward-compatible fields; existing clients are unaffected.
- Each concern is isolated behind a small, named seam with a documented extension path, keeping the Feature-Based Modular Monolith consistent rather than accreting ad hoc operational code across the modules.
