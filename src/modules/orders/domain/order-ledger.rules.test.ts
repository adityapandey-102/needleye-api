import { describe, expect, it } from "vitest";
import { derivePaymentStatus } from "./order-ledger.rules";

describe("derivePaymentStatus", () => {
  it("is not_priced while the order has no total (ADR 0008)", () => {
    expect(derivePaymentStatus(0, null)).toBe("not_priced");
  });

  it("is unpaid when nothing has been recorded", () => {
    expect(derivePaymentStatus(0, 5000)).toBe("unpaid");
  });

  it("is advance_paid when some, but less than the total, is recorded", () => {
    expect(derivePaymentStatus(2000, 5000)).toBe("advance_paid");
  });

  it("is fully_paid when the recorded sum reaches the total", () => {
    expect(derivePaymentStatus(5000, 5000)).toBe("fully_paid");
  });

  it("is fully_paid when the recorded decimal sum meets the total exactly", () => {
    expect(derivePaymentStatus("0.30", "0.30")).toBe("fully_paid");
  });

  it("treats a zero-total order (free work) as fully_paid -- nothing to collect", () => {
    expect(derivePaymentStatus(0, 0)).toBe("fully_paid");
    expect(derivePaymentStatus("0.00", "0.00")).toBe("fully_paid");
  });

  it("goes back to unpaid when a zero total is edited up with an empty ledger", () => {
    expect(derivePaymentStatus("0.00", "4500.00")).toBe("unpaid");
  });
});
