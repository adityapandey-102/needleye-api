import { pgTable, uuid, text, numeric, date, timestamp } from "drizzle-orm/pg-core";
import type { PaymentMethod } from "../../../domain";

/**
 * This module's own slice of the Drizzle schema -- the Payments module
 * owns this table. See common/database/drizzle-client.ts for how every
 * module's per-module schema file gets aggregated into the one Drizzle
 * client.
 */
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  method: text("method").notNull().$type<PaymentMethod>(),
  paidAt: date("paid_at").notNull(),
  recordedBy: uuid("recorded_by"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
