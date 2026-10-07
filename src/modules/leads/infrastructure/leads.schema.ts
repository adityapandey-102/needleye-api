import { pgTable, uuid, text, integer, boolean, date, timestamp } from "drizzle-orm/pg-core";
import type { LeadEventKind, LeadSource, LeadStatus } from "../domain/lead.entity";

/**
 * The Leads module's own slice of the Drizzle schema (DDL in
 * supabase/migrations/20261006000001_leads.sql). See
 * common/database/drizzle-client.ts for the aggregation point.
 */
export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadNumber: text("lead_number").notNull(),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  requirement: text("requirement").notNull(),
  source: text("source").notNull().$type<LeadSource>(),
  status: text("status").notNull().$type<LeadStatus>(),
  assignedTo: uuid("assigned_to"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  urgent: boolean("urgent").notNull(),
  enquiryCount: integer("enquiry_count").notNull(),
  firstEnquiryAt: timestamp("first_enquiry_at", { withTimezone: true }).notNull(),
  lastEnquiryAt: timestamp("last_enquiry_at", { withTimezone: true }).notNull(),
  followUpOn: date("follow_up_on"),
  lostReason: text("lost_reason"),
  convertedOrderId: uuid("converted_order_id"),
  createdBy: uuid("created_by"),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leadComments = pgTable("lead_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  authorId: uuid("author_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leadEvents = pgTable("lead_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  actorId: uuid("actor_id"),
  kind: text("kind").notNull().$type<LeadEventKind>(),
  fromStatus: text("from_status").$type<LeadStatus>(),
  toStatus: text("to_status").$type<LeadStatus>(),
  assignedTo: uuid("assigned_to"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
