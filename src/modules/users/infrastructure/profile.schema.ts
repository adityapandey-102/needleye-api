import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import type { Role } from "../../../domain";

/**
 * The Users module owns `profiles` -- every other module that needs a
 * profile row (Team Members' listing, Orders' designer/masterTailor
 * relations, Auth's login/QR flows) reads it via an
 * Infrastructure-to-Infrastructure import of this file, never through
 * Users' Application/Domain layers. See
 * docs/adr/0003-per-module-schema-ownership.md.
 *
 * Deliberately does NOT include auth.users (Supabase Auth's own schema) or
 * RLS/the handle_new_user() trigger -- those stay in supabase/migrations/*.sql,
 * genuinely vendor-specific glue. The `role` CHECK constraint already exists
 * at the DB level from the original migrations; modeled here via $type<Role>()
 * for compile-time typing only, so this file introduces zero DDL drift.
 */
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().$type<Role>(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});
