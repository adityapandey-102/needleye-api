import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import type { GranularStatus } from "../../../domain";

/**
 * The Orders module owns `order_status_history` too -- an append-only audit
 * trail, child of `orders`. Never written to directly by a client; every row
 * is inserted alongside an `orders.production_status` update, in the same
 * transaction (see DrizzleOrdersRepository.create()/updateStatus()).
 */
export const orderStatusHistory = pgTable("order_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull(),
  status: text("status").notNull().$type<GranularStatus>(),
  label: text("label").notNull(),
  changedBy: uuid("changed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
