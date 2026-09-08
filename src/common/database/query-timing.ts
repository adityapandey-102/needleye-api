import type { Pool, PoolClient } from "pg";
import { env } from "../../config/env";
import { logger } from "../logger/logger";
import { getRequestContext } from "../context/request-context";
import { describeDbError, dbErrorLabel } from "./db-logging";

/**
 * Database observability. Wraps the pool's query path to capture two things:
 *
 *  1. Slow queries -- any statement over SLOW_QUERY_MS (default 250ms) is logged
 *     at WARN with its duration and the current request's id/user.
 *  2. FAILED queries -- every query rejection is logged at ERROR at the DB layer,
 *     with the pg SQLSTATE/constraint/table (see db-logging.ts) and request
 *     context. This is the fix for "the database failed but nothing was
 *     logged": a DB error is now traced right where it happens, even if a caller
 *     later swallows it or it never reaches the HTTP error middleware.
 *
 * Only the SQL text is logged, never the parameter VALUES (which can contain
 * customer data), and never pg's `detail` (which can contain row values). This
 * provides visibility; it never changes or optimizes a query.
 *
 * Covers both non-transaction queries (`pool.query`) and the per-statement
 * queries inside transactions (via the client handed out by `pool.connect`).
 * Isolated here so drizzle-client.ts just calls instrumentPoolTiming(pool).
 */

const patchedClients = new WeakSet<object>();

function truncateSql(sql: string): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

function extractSql(firstArg: unknown): string {
  if (typeof firstArg === "string") return firstArg;
  if (firstArg && typeof firstArg === "object" && "text" in firstArg) {
    const text = (firstArg as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "<unknown>";
}

function logIfSlow(sql: string, startedAt: number): void {
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs < env.SLOW_QUERY_MS) return;
  const ctx = getRequestContext();
  logger.warn(
    {
      durationMs,
      thresholdMs: env.SLOW_QUERY_MS,
      sql: truncateSql(sql),
      requestId: ctx?.requestId,
      userId: ctx?.userId,
    },
    `Slow query (${durationMs}ms)`,
  );
}

/** Logs a failed query at the DB layer with safe pg metadata + request context. */
function logQueryError(sql: string, error: unknown): void {
  const ctx = getRequestContext();
  const db = describeDbError(error);
  const label = dbErrorLabel(db?.code);
  logger.error(
    {
      db: db ?? { message: error instanceof Error ? error.message : String(error) },
      label,
      sql: truncateSql(sql),
      requestId: ctx?.requestId,
      userId: ctx?.userId,
    },
    `Database query failed${db?.code ? ` (${db.code}${label ? ` ${label}` : ""})` : ""}`,
  );
}

/** Wraps a `query`-bearing target (Pool or PoolClient) so promise-returning queries are timed. */
function wrapQueryMethod(target: { query: (...args: unknown[]) => unknown }): void {
  if (patchedClients.has(target)) return;
  patchedClients.add(target);

  const original = target.query.bind(target);
  target.query = function timedQuery(...args: unknown[]): unknown {
    // Callback form (last arg is a function) -- pass straight through; Drizzle
    // never uses it, and timing a callback API isn't worth the complexity.
    if (typeof args[args.length - 1] === "function") return original(...args);

    const sql = extractSql(args[0]);
    const startedAt = performance.now();
    const result = original(...args);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (result as Promise<unknown>).then(
        (value) => {
          logIfSlow(sql, startedAt);
          return value;
        },
        (error: unknown) => {
          logIfSlow(sql, startedAt);
          logQueryError(sql, error);
          throw error;
        },
      );
    }
    return result;
  };
}

export function instrumentPoolTiming(pool: Pool): void {
  wrapQueryMethod(pool);

  // Transactions run their statements on a checked-out client; wrap each one
  // as it's handed out (the WeakSet guard makes re-wrapping a reused client a no-op).
  const originalConnect = pool.connect.bind(pool);
  pool.connect = function instrumentedConnect(...args: unknown[]): unknown {
    if (typeof args[args.length - 1] === "function") return (originalConnect as (...a: unknown[]) => unknown)(...args);
    return (originalConnect as () => Promise<PoolClient>)().then((client) => {
      wrapQueryMethod(client);
      return client;
    });
  } as typeof pool.connect;
}
