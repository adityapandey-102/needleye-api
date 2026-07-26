import { describe, expect, it } from "vitest";
import { canViewPaymentFields } from "./order-visibility.rules";

describe("canViewPaymentFields", () => {
  it("grants payment visibility to owner_manager, designer, and accountant", () => {
    expect(canViewPaymentFields("owner_manager")).toBe(true);
    expect(canViewPaymentFields("designer")).toBe(true);
    expect(canViewPaymentFields("accountant")).toBe(true);
  });

  it("denies master_tailor any payment visibility", () => {
    expect(canViewPaymentFields("master_tailor")).toBe(false);
  });
});
