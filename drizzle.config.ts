import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Owns the portable business schema going forward. Every module owns its
 * own schema file (`modules/*/infrastructure/*.schema.ts`); this glob picks
 * all of them up -- see docs/adr/0001-feature-based-clean-architecture-per-module.md
 * and docs/adr/0003-per-module-schema-ownership.md. The existing tables
 * were created by supabase/migrations/*.sql and already match this schema
 * exactly -- this config's migrations folder starts empty on purpose;
 * `drizzle-kit generate` is for the NEXT schema change (e.g. Phase 4's
 * order_status_history table), not a rewrite of history.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/modules/*/infrastructure/*.schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
