import { defineConfig } from "vitest/config";

// Integration tests hit a real Postgres instance (the local Supabase stack,
// `npx supabase start`) -- see tests/integration/README.md. Kept in a
// separate config/dir from unit tests so `npm run test:unit` never needs a
// database and stays fast enough to run on every save.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
  },
});
