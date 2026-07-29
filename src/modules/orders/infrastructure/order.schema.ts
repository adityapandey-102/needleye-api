import { pgTable, uuid, text, boolean, timestamp, numeric, date, integer } from "drizzle-orm/pg-core";
import type { GranularStatus, ProductCategory, PaymentStatus } from "../../../domain";

/**
 * The Orders module owns `orders` -- the largest and last module converted
 * to the per-module Clean Architecture layout. See
 * docs/adr/0001-feature-based-clean-architecture-per-module.md.
 *
 * CHECK constraints (category/status enums) already exist at the DB level
 * from the original migrations and are unchanged -- modeled here via
 * $type<T>() for compile-time typing only, so this file introduces zero DDL
 * drift against what's already deployed.
 */
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: text("order_number").notNull(),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  billNumber: text("bill_number").notNull(),
  bookingDate: date("booking_date").notNull(),
  dueDate: date("due_date").notNull(),
  designerId: uuid("designer_id").notNull(),
  masterTailorId: uuid("master_tailor_id").notNull(),
  productCategory: text("product_category").notNull().$type<ProductCategory>(),
  orderDetails: text("order_details").notNull(),
  handWork: boolean("hand_work").notNull().default(false),
  machineWork: boolean("machine_work").notNull().default(false),
  purchaseRequired: boolean("purchase_required").notNull().default(false),
  paymentStatus: text("payment_status").notNull().$type<PaymentStatus>(),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  productionStatus: text("production_status").notNull().$type<GranularStatus>().default("design_pending"),
  designerInstructions: text("designer_instructions"),
  specialNotes: text("special_notes"),
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
