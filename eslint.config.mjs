import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  // supabase/.temp is a transient artifact the Supabase CLI writes on `supabase
  // start` (and gitignores); linting it is nondeterministic (present only when
  // the local stack is running) and it isn't our source.
  globalIgnores(["dist/**", "drizzle/**", "node_modules/**", "supabase/.temp/**"]),
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Every repository/provider method already declares its own return
      // type explicitly (see README's layer responsibilities); this rule
      // would just add noise on top of that existing discipline.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tests/**/*.mjs", "*.config.{ts,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
]);
