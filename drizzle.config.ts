import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Owns the portable business schema going forward. Every module owns its
// own schema file, under that module's own infrastructure folder; the
// `schema` glob below picks all of them up -- see
// docs/adr/0001-feature-based-clean-architecture-per-module.md and
// docs/adr/0003-per-module-schema-ownership.md. The existing tables were
// created by the supabase/migrations SQL files and already match this
// schema exactly -- this config's migrations folder starts empty on
// purpose; `drizzle-kit generate` is for the NEXT schema change, not a
// rewrite of history.
//
// NOTE for future edits: this file sits outside tsconfig.json's `include`,
// so `tsc` never typechecks it -- only `eslint .` does. A block comment
// here that happens to contain a glob-path with a star immediately
// followed by a slash closes early and silently corrupts everything until
// the next such pair, undetected by tsc. Use line comments (like this
// whole block) instead of a block comment if a glob path needs describing.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/modules/*/infrastructure/*.schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
