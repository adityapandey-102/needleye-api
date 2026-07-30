import { describe, expect, it } from "vitest";
import { derivePaymentStatus } from "./order-ledger.rules";

describe("derivePaymentStatus", () => {
  it("is unpaid when nothing has been recorded", () => {
    expect(derivePaymentStatus(0, 5000)).toBe("unpaid");
  });

  it("is advance_paid when some, but less than the total, is recorded", () => {
    expect(derivePaymentStatus(2000, 5000)).toBe("advance_paid");
  });

  it("is fully_paid when the recorded sum reaches the total", () => {
    expect(derivePaymentStatus(5000, 5000)).toBe("fully_paid");
  });

  it("is fully_paid when the recorded sum meets the total across cent rounding", () => {
    expect(derivePaymentStatus(0.1 + 0.2, 0.3)).toBe("fully_paid");
  });

  it("treats a zero-total order as unpaid", () => {
    expect(derivePaymentStatus(0, 0)).toBe("unpaid");
  });
});
