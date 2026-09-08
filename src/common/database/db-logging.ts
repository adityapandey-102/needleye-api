/**
 * Database event tracing. Postgres/connection failures are the class of error
 * most likely to fail "silently" -- swallowed by a caller, or surfacing only as
 * a generic 500 -- so this centralises how we describe and log them.
 *
 * The key rule (per the engineering charter): log the pg error's SAFE metadata
 * -- SQLSTATE `code`, `constraint`, `table`, `schema`, `column`, `routine`,
 * `severity`, and the template `message` -- but NEVER pg's `detail`/`where`,
 * which for a constraint violation contain the offending ROW VALUES (customer
 * data). That's enough to diagnose "which constraint on which table failed"
 * without logging PII.
 */

/** A node-postgres DatabaseError, or a connection-level Node error (ECONNREFUSED etc.). */
export interface DbErrorInfo {
  /** SQLSTATE (e.g. "23505" unique_violation, "40P01" deadlock) or a Node errno ("ECONNREFUSED"). */
  code?: string;
  severity?: string;
  constraint?: string;
  table?: string;
  schema?: string;
  column?: string;
  routine?: string;
  /** pg's template message -- value-free (the values live in `detail`, which we never log). */
  message?: string;
}

const SAFE_FIELDS = ["code", "severity", "constraint", "table", "schema", "column", "routine"] as const;

/**
 * Extracts the safe, non-PII fields from a pg/connection error. Returns
 * `undefined` for anything that isn't database-shaped, so callers can tell a DB
 * failure apart from an ordinary error.
 */
export function describeDbError(err: unknown): DbErrorInfo | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  const looksLikeDbError =
    typeof e.code === "string" || "severity" in e || "routine" in e || "constraint" in e || ("table" in e && "schema" in e);
  if (!looksLikeDbError) return undefined;

  const info: DbErrorInfo = {};
  for (const key of SAFE_FIELDS) {
    const value = e[key];
    if (typeof value === "string" && value.length > 0) info[key] = value;
  }
  // pg messages are template text ("duplicate key value violates unique
  // constraint \"x\"") with no row values -- safe to log; the values are in
  // `detail`, which we deliberately omit.
  if (typeof e.message === "string") info.message = e.message;
  return Object.keys(info).length > 0 ? info : undefined;
}

/** Human-readable label for the common SQLSTATE codes, for log readability. */
export function dbErrorLabel(code: string | undefined): string | undefined {
  switch (code) {
    case "23505":
      return "unique_violation";
    case "23503":
      return "foreign_key_violation";
    case "23502":
      return "not_null_violation";
    case "23514":
      return "check_violation";
    case "40001":
      return "serialization_failure";
    case "40P01":
      return "deadlock_detected";
    case "53300":
      return "too_many_connections";
    case "57014":
      return "query_canceled";
    case "57P01":
      return "admin_shutdown";
    case "08006":
    case "08003":
    case "08000":
      return "connection_failure";
    case "ECONNREFUSED":
      return "connection_refused";
    case "ETIMEDOUT":
      return "connection_timeout";
    default:
      return undefined;
  }
}
