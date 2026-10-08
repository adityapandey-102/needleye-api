import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import type { OrderAuditAction, OrderFieldChanges } from "../domain/order-audit.rules";

/**
 * The Orders module owns `order_audit_log` (ADR 0008, phase 3): one
 * append-only row per order created / edited / reference image removed. An
 * edit records each changed field's before and after value. Written by
 * DrizzleOrdersRepository in the SAME transaction as the change it records; a
 * database trigger refuses updates and deletes. Stage moves and price changes
 * have their own logs (order_status_history, order_price_history).
 */
export const orderAuditLog = pgTable("order_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull(),
  action: text("action").notNull().$type<OrderAuditAction>(),
  changes: jsonb("changes").$type<OrderFieldChanges>(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  actorId: uuid("actor_id"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
