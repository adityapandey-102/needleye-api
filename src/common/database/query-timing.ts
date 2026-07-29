import type { Pool, PoolClient } from "pg";
import { env } from "../../config/env";
import { logger } from "../logger/logger";
import { getRequestContext } from "../context/request-context";

/**
 * Slow-query observability. Wraps the pool's query path so any statement
 * slower than SLOW_QUERY_MS (default 250ms) is logged at WARN with its
 * duration and the current request's id/user -- turning "the app feels slow"
 * into "this specific query on this specific request took N ms."
 *
 * Only the SQL text is logged, never the parameter VALUES (which can contain
 * customer data). This provides visibility; it never changes or optimizes a
 * query -- that's a human's call, informed by these logs.
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
      return (result as Promise<unknown>).finally(() => logIfSlow(sql, startedAt));
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
