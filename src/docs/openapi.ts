import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

/**
 * Loaded once at startup from the repo-root openapi.yaml -- the single
 * source of truth for the API's request/response contracts, served at
 * GET /api-docs. Resolved against process.cwd() (not import.meta.url)
 * because that stays correct whether the process is started via `npm run
 * dev` (tsx, running straight from src/) or `npm start` (tsup's bundled
 * dist/index.js) -- both are always launched from the repo root.
 */
export const openApiDocument = load(readFileSync(join(process.cwd(), "openapi.yaml"), "utf-8")) as Record<
  string,
  unknown
>;
