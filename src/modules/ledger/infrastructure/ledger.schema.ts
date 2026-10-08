import { pgTable, date, integer, numeric, timestamp } from "drizzle-orm/pg-core";

/**
 * The Ledger module owns `ledger_daily` (ADR 0008, phase 4): one row per shop
 * day, maintained ONLY by database triggers on orders and payments
 * (supabase/migrations/20261011000001_ledger_daily.sql). The app reads it and
 * never writes it -- it has no write grant.
 */
export const ledgerDaily = pgTable("ledger_daily", {
  day: date("day").primaryKey(),
  ordersBooked: integer("orders_booked").notNull(),
  ordersPriced: integer("orders_priced").notNull(),
  bookedTotal: numeric("booked_total", { precision: 14, scale: 2 }).notNull(),
  paidOnBooked: numeric("paid_on_booked", { precision: 14, scale: 2 }).notNull(),
  cashCollected: numeric("cash_collected", { precision: 14, scale: 2 }).notNull(),
  paymentsCount: integer("payments_count").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
