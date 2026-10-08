import { pgTable, uuid, text, timestamp, numeric } from "drizzle-orm/pg-core";
import type { PriceHistoryKind } from "../domain/order-pricing.rules";

/**
 * The Orders module owns `order_price_history` -- every price set / raise /
 * discount (ADR 0008). Append-only (a database trigger refuses updates and
 * deletes); every row is inserted in the same transaction as the
 * `orders.total_amount` change it records (see DrizzleOrdersRepository.create()
 * / changePrice()).
 */
export const orderPriceHistory = pgTable("order_price_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull(),
  kind: text("kind").notNull().$type<PriceHistoryKind>(),
  previousTotal: numeric("previous_total", { precision: 12, scale: 2 }),
  newTotal: numeric("new_total", { precision: 12, scale: 2 }).notNull(),
  collected: numeric("collected", { precision: 12, scale: 2 }).notNull(),
  reason: text("reason"),
  changedBy: uuid("changed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
