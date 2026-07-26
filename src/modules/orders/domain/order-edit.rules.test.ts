import { describe, expect, it } from "vitest";
import { assertFieldsEditable, assertOwnershipForScopedEdit } from "./order-edit.rules";
import { ForbiddenError } from "../../../common/errors/app-error";

describe("assertFieldsEditable", () => {
  it("lets owner_manager edit customer/product and pricing/assignment fields with no ownership check", () => {
    const decision = assertFieldsEditable("owner_manager", ["totalAmount", "customerName"]);
    expect(decision.needsOwnershipCheck).toBe(false);
  });

  it("lets a designer edit customer/product fields on their own order, flagged for an ownership check", () => {
    const decision = assertFieldsEditable("designer", ["customerName", "productType"]);
    expect(decision.needsOwnershipCheck).toBe(true);
  });

  it("forbids a designer from touching pricing/assignment fields at all", () => {
    expect(() => assertFieldsEditable("designer", ["totalAmount"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("designer", ["designerId"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("designer", ["masterTailorId"])).toThrow(ForbiddenError);
  });

  it("forbids master_tailor and accountant from editing any order field", () => {
    expect(() => assertFieldsEditable("master_tailor", ["customerName"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("accountant", ["customerName"])).toThrow(ForbiddenError);
  });

  it("requires an ownership check when a submission mixes pricing and customer/product fields for a designer", () => {
    // The pricing check throws first since a designer can never touch it, regardless of ordering.
    expect(() => assertFieldsEditable("designer", ["customerName", "totalAmount"])).toThrow(ForbiddenError);
  });
});

describe("assertOwnershipForScopedEdit", () => {
  it("allows the edit when the caller is the order's designer", () => {
    expect(() => assertOwnershipForScopedEdit("designer-1", "designer-1")).not.toThrow();
  });

  it("forbids the edit when the caller is not the order's designer", () => {
    expect(() => assertOwnershipForScopedEdit("designer-1", "designer-2")).toThrow(ForbiddenError);
  });
});
