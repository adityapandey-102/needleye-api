import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of the `audit_log` table (DDL in
 * supabase/migrations/20260726000001_audit_log.sql). A cross-cutting
 * infrastructure table, not owned by any business module -- so it lives in
 * common/, alongside the AuditLogger that writes it, rather than under a
 * modules/* folder. $type-only typing; introduces no DDL of its own.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
