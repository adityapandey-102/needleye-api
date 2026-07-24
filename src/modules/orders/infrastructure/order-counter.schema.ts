import { pgTable, integer } from "drizzle-orm/pg-core";

/**
 * Backs the orders_set_order_number trigger (see supabase/migrations) that
 * generates ORD-{year}-{seq} order numbers with a locking upsert -- never
 * queried directly from TypeScript, but included here so drizzle-kit's
 * migration diffing and the relational query API's aggregated schema stay
 * complete.
 */
export const orderCounters = pgTable("order_counters", {
  year: integer("year").primaryKey(),
  nextSeq: integer("next_seq").notNull().default(1),
});
