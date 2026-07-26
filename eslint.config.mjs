import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", "drizzle/**", "node_modules/**"]),
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
