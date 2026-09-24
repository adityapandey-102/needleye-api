import { describe, expect, it } from "vitest";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_GROUPS,
  PRODUCT_CATEGORY_VALUES,
  productCategoryGroup,
  productCategoryLabel,
} from "./product-categories";

describe("product catalogue", () => {
  it("has 43 categories across 6 collections, every value unique", () => {
    expect(PRODUCT_CATEGORIES).toHaveLength(43);
    expect(PRODUCT_CATEGORY_GROUPS).toHaveLength(6);
    expect(new Set(PRODUCT_CATEGORY_VALUES).size).toBe(43);
  });

  it("puts every category in a real collection, and leaves no collection empty", () => {
    const groups = new Set<string>(PRODUCT_CATEGORY_GROUPS.map((g) => g.value));
    for (const c of PRODUCT_CATEGORIES) expect(groups.has(c.group)).toBe(true);
    for (const g of PRODUCT_CATEGORY_GROUPS) {
      expect(PRODUCT_CATEGORIES.some((c) => c.group === g.value)).toBe(true);
    }
  });

  it("REGRESSION GUARD: keeps the five original stored values -- live orders use them", () => {
    // Renaming or removing any of these orphans every existing order that stores
    // it. Labels may change; these values must not.
    for (const original of ["designer_blouse", "saree", "bridal_lehenga", "custom_ethnic_wear", "boutique_fashion"]) {
      expect(PRODUCT_CATEGORY_VALUES).toContain(original);
    }
  });

  it("keeps the labels that appear twice (Shirt, Pant) as distinct values in different collections", () => {
    expect(productCategoryLabel("shirt")).toBe("Shirt");
    expect(productCategoryLabel("mens_shirt")).toBe("Shirt");
    expect(productCategoryGroup("shirt")).toBe("upper_body");
    expect(productCategoryGroup("mens_shirt")).toBe("mens_wear");
    expect(productCategoryGroup("pant")).toBe("lower_body");
    expect(productCategoryGroup("mens_pant")).toBe("mens_wear");
  });

  it("shows the business's own spelling but stores a correctly spelled value", () => {
    expect(productCategoryLabel("divided_skirt")).toBe("Devided Skirt");
    expect(productCategoryLabel("palazzo")).toBe("Plazo");
    expect(productCategoryLabel("petticoat")).toBe("Peticoat");
  });

  it("falls back to the raw value for an unknown category", () => {
    expect(productCategoryLabel("not_a_category")).toBe("not_a_category");
    expect(productCategoryGroup("not_a_category")).toBeUndefined();
  });
});
