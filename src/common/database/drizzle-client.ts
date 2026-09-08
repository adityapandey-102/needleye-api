import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../../config/env";
import { logger } from "../logger/logger";
import { instrumentPoolTiming } from "./query-timing";
import { describeDbError, dbErrorLabel } from "./db-logging";
import * as paymentsSchema from "../../modules/payments/infrastructure/payments.schema";
import * as usersSchema from "../../modules/users/infrastructure/profile.schema";
import * as authSchema from "../../modules/auth/infrastructure/qr-login.schema";
import * as orderSchema from "../../modules/orders/infrastructure/order.schema";
import * as orderImageSchema from "../../modules/orders/infrastructure/order-image.schema";
import * as orderCounterSchema from "../../modules/orders/infrastructure/order-counter.schema";
import * as orderStatusHistorySchema from "../../modules/orders/infrastructure/order-status-history.schema";
import * as orderRelationsSchema from "../../modules/orders/infrastructure/order.relations";
import * as auditLogSchema from "../audit/audit-log.schema";

/**
 * The one Postgres connection pool every repository queries through.
 * Connects via DATABASE_URL -- a plain Postgres connection string, true
 * regardless of who's hosting it (Supabase, RDS, Neon, self-hosted). This
 * is the actual database-portability seam: repositories only ever import
 * `db` and their own module's schema from here, never a vendor client
 * directly.
 *
 * Schema aggregation point: every module now owns its own
 * `infrastructure/*.schema.ts` (see docs/adr/0001, 0003) -- this is the one
 * place that needs to know about every module's schema, since Drizzle's
 * relational query API and `db.query.*` need one combined schema object to
 * build against. This file contains no business logic; it's pure
 * "Infrastructure bootstrap," an explicitly allowed Shared concern.
 */
const schema = {
  ...paymentsSchema,
  ...usersSchema,
  ...authSchema,
  ...orderSchema,
  ...orderImageSchema,
  ...orderCounterSchema,
  ...orderStatusHistorySchema,
  ...orderRelationsSchema,
  ...auditLogSchema,
};

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Explicit bounds rather than pg's silent defaults: cap concurrent
  // connections (the whole app shares this one pool -- DB_POOL_MAX, the main
  // concurrency lever), reap idle ones, and -- most importantly -- fail a
  // request fast if no connection is available within 5s instead of hanging it
  // forever (pg's default is no timeout).
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// CRITICAL: an idle pooled client can emit 'error' on its own when the database
// drops the connection (failover, restart, sleep, network blip). Without this
// listener, node-postgres re-throws it as an uncaughtException and the whole
// process crashes -- with the error going to stderr, outside the pino log, so
// it looks like the API "just stopped." Log it and carry on: pg opens a fresh
// connection on the next query, so a transient DB blip must never take the API
// down. (See also the uncaughtException/unhandledRejection net in index.ts.)
pool.on("error", (err) => {
  const db = describeDbError(err);
  logger.error(
    { db: db ?? { message: err.message }, label: dbErrorLabel(db?.code) },
    "Idle Postgres client error -- DB connection dropped; pool will reconnect on next query",
  );
});

// DB connection lifecycle tracing (debug level, so it's available when
// diagnosing connection churn/pool exhaustion but silent in normal INFO logs).
// A brand-new physical connection was opened; `totalCount` is the pool size.
pool.on("connect", () => {
  logger.debug({ poolTotal: pool.totalCount, poolIdle: pool.idleCount, poolWaiting: pool.waitingCount }, "Postgres connection established");
});

// Slow-query observability -- logs any statement over SLOW_QUERY_MS. Must wrap
// the pool before Drizzle starts issuing queries through it.
instrumentPoolTiming(pool);

export const db = drizzle(pool, { schema });
