import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  // @needleye/shared ships raw TypeScript (no build step of its own -- see
  // its README), so it can't be left as an external runtime import like a
  // normal npm dependency; esbuild needs to inline it into the bundle.
  noExternal: ["@needleye/shared"],
});
