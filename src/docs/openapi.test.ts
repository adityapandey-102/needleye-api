import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";
import { GRANULAR_STATUS_VALUES, PRODUCT_CATEGORY_VALUES } from "../domain";

/**
 * openapi.yaml is hand-maintained, so its enums can silently drift from the
 * domain lists the API actually validates against (it had: the status endpoint
 * described capabilities that no longer existed). These pin the two enums that
 * change with the business -- a new stage or category that isn't documented
 * fails CI instead of shipping a wrong contract.
 */
type Schemas = Record<string, { enum?: string[] }>;
const schemas = (openApiDocument as { components: { schemas: Schemas } }).components.schemas;

describe("openapi.yaml stays in sync with the domain", () => {
  it("documents exactly the stored product-category values, in order", () => {
    expect(schemas.ProductCategory?.enum).toEqual([...PRODUCT_CATEGORY_VALUES]);
  });

  it("documents exactly the production stages, in flow order", () => {
    expect(schemas.GranularStatus?.enum).toEqual([...GRANULAR_STATUS_VALUES]);
  });
});
