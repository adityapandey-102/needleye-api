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

  it("lets a designer change the total of their own order, flagged for an ownership check", () => {
    expect(assertFieldsEditable("designer", ["totalAmount"]).needsOwnershipCheck).toBe(true);
    // The edit form resends total + details together -- still one ownership check.
    expect(assertFieldsEditable("designer", ["customerName", "totalAmount"]).needsOwnershipCheck).toBe(true);
  });

  it("forbids a designer from reassigning the designer or master tailor", () => {
    expect(() => assertFieldsEditable("designer", ["designerId"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("designer", ["masterTailorId"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("designer", ["totalAmount", "masterTailorId"])).toThrow(ForbiddenError);
  });

  it("forbids master_tailor and accountant from editing any order field, the total included", () => {
    expect(() => assertFieldsEditable("master_tailor", ["customerName"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("accountant", ["customerName"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("master_tailor", ["totalAmount"])).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable("accountant", ["totalAmount"])).toThrow(ForbiddenError);
  });

  it("forbids a production manager from changing the total (PM edits info, never pricing)", () => {
    expect(assertFieldsEditable("production_manager", ["customerName"]).needsOwnershipCheck).toBe(false);
    expect(() => assertFieldsEditable("production_manager", ["totalAmount"])).toThrow(ForbiddenError);
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
