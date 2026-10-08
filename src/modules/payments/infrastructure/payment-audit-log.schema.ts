import { pgTable, uuid, text, numeric, date, timestamp } from "drizzle-orm/pg-core";

export type PaymentAuditAction = "created" | "updated" | "deleted";

/**
 * The Payments module owns `payment_audit_log` (ADR 0008, phase 3): one
 * append-only row per payment recorded / edited / removed, with typed values
 * -- the payment as it is after the action (or as it was when removed) and,
 * for an edit, what it was before. Written by DrizzlePaymentsRepository in the
 * SAME transaction as the payment change, so the two can't disagree. A
 * database trigger refuses updates and deletes.
 */
export const paymentAuditLog = pgTable("payment_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull(),
  orderId: uuid("order_id").notNull(),
  action: text("action").notNull().$type<PaymentAuditAction>(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  method: text("method").notNull(),
  paidAt: date("paid_at").notNull(),
  notes: text("notes"),
  previousAmount: numeric("previous_amount", { precision: 12, scale: 2 }),
  previousMethod: text("previous_method"),
  previousPaidAt: date("previous_paid_at"),
  previousNotes: text("previous_notes"),
  actorId: uuid("actor_id"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
