import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../../config/env";
import * as paymentsSchema from "../../modules/payments/infrastructure/payments.schema";
import * as usersSchema from "../../modules/users/infrastructure/profile.schema";
import * as authSchema from "../../modules/auth/infrastructure/qr-login.schema";
import * as orderSchema from "../../modules/orders/infrastructure/order.schema";
import * as orderImageSchema from "../../modules/orders/infrastructure/order-image.schema";
import * as orderCounterSchema from "../../modules/orders/infrastructure/order-counter.schema";
import * as orderStatusHistorySchema from "../../modules/orders/infrastructure/order-status-history.schema";
import * as orderRelationsSchema from "../../modules/orders/infrastructure/order.relations";

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
};

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Explicit bounds rather than pg's silent defaults: cap concurrent
  // connections (the whole app shares this one pool), reap idle ones, and --
  // most importantly -- fail a request fast if no connection is available
  // within 5s instead of hanging it forever (pg's default is no timeout).
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });
