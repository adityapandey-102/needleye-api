import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The Auth module owns `qr_login_tokens` -- the Users module (which issues
 * new tokens and clears them on deactivation) reads/writes it via an
 * Infrastructure-to-Infrastructure import of this file, never through
 * Auth's Application/Domain layers. See
 * docs/adr/0003-per-module-schema-ownership.md.
 *
 * Only ever stores a hash (see the original migration comment) -- the QR
 * login flow looks up the profile by hash, then asks AuthProvider to mint a
 * session for that email; the raw token itself is never persisted.
 */
export const qrLoginTokens = pgTable("qr_login_tokens", {
  profileId: uuid("profile_id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
