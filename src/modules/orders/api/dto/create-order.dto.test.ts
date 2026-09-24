import { describe, expect, it } from "vitest";
import { createOrderDtoSchema } from "./create-order.dto";

/**
 * productCategory validation lives HERE now: the database CHECK on
 * orders.product_category was dropped (migration 20260924000002), so this zod
 * enum -- built from PRODUCT_CATEGORY_VALUES -- is the only thing standing
 * between a bad value and the orders table.
 */
describe("createOrderDtoSchema productCategory", () => {
  const base = {
    customerName: "A",
    phone: "9000000000",
    billNumber: "B-1",
    dueDate: "2026-02-01",
    designerId: "00000000-0000-4000-8000-000000000001",
    masterTailorId: "00000000-0000-4000-8000-000000000002",
    orderDetails: "x",
    productionStatus: "design_pending",
  };

  it("accepts new catalogue categories and the original ones", () => {
    for (const productCategory of ["anarkali", "mens_shirt", "kids_girls_custom", "petticoat", "saree"]) {
      const result = createOrderDtoSchema.safeParse({ ...base, productCategory });
      expect(result.success, productCategory).toBe(true);
    }
  });

  it("rejects a value that isn't in the catalogue, with the form's message", () => {
    const result = createOrderDtoSchema.safeParse({ ...base, productCategory: "not_a_category" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Please select a category");
  });

  it("rejects a label passed where a value belongs (\"Saree\" is not \"saree\")", () => {
    expect(createOrderDtoSchema.safeParse({ ...base, productCategory: "Saree" }).success).toBe(false);
  });
});
