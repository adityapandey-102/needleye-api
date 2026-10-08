import { pgTable, date, integer, numeric, timestamp, uuid, text, jsonb } from "drizzle-orm/pg-core";

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

/**
 * `ledger_month_closings` (ADR 0008, phase 5): every close and reopen of a
 * month, append-only. A close carries the month's figures at that moment.
 */
export const ledgerMonthClosings = pgTable("ledger_month_closings", {
  id: uuid("id").primaryKey().defaultRandom(),
  month: date("month").notNull(),
  action: text("action").notNull().$type<"closed" | "reopened">(),
  ordersBooked: integer("orders_booked"),
  ordersPriced: integer("orders_priced"),
  bookedTotal: numeric("booked_total", { precision: 14, scale: 2 }),
  paidOnBooked: numeric("paid_on_booked", { precision: 14, scale: 2 }),
  cashCollected: numeric("cash_collected", { precision: 14, scale: 2 }),
  paymentsCount: integer("payments_count"),
  reason: text("reason"),
  actorId: uuid("actor_id"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `ledger_reconciliations`: one row per check, written only by the ledger_reconcile() database function. */
export const ledgerReconciliations = pgTable("ledger_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull().$type<"nightly" | "manual">(),
  requestedBy: uuid("requested_by"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().$type<"verified" | "problems">(),
  daysChecked: integer("days_checked").notNull(),
  mismatchedDays: integer("mismatched_days").notNull(),
  mismatches: jsonb("mismatches").notNull().$type<Record<string, unknown>[]>(),
  overpaidOrders: integer("overpaid_orders").notNull(),
  statusMismatches: integer("status_mismatches").notNull(),
  closedMonthDrift: integer("closed_month_drift").notNull(),
  details: jsonb("details").notNull().$type<{ closedMonths?: Record<string, unknown>[] }>(),
});
