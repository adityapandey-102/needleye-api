import { describe, expect, it } from "vitest";
import { assertTotalCoversLedger, derivePaymentStatus } from "./order-ledger.rules";
import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

describe("assertTotalCoversLedger", () => {
  it("allows a total above the recorded ledger sum", () => {
    expect(() => assertTotalCoversLedger(10000, 4000)).not.toThrow();
  });

  it("allows a total exactly equal to the recorded ledger sum (fully paid)", () => {
    expect(() => assertTotalCoversLedger(5000, 5000)).not.toThrow();
  });

  it("rejects lowering the total below what's already collected (would be overpaid)", () => {
    expect(() => assertTotalCoversLedger(8000, 10000)).toThrow(BadRequestError);
  });

  it("carries the ORDER_TOTAL_BELOW_PAID code and both amounts in the message", () => {
    try {
      assertTotalCoversLedger(8000, 10000);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as BadRequestError).code).toBe(ERROR_CODES.ORDER_TOTAL_BELOW_PAID);
      expect((err as Error).message).toContain("8000");
      expect((err as Error).message).toContain("10000");
    }
  });

  it("compares decimal strings exactly (no float drift at the boundary)", () => {
    // Money crosses every boundary as a 2dp string, so the comparison is exact.
    expect(() => assertTotalCoversLedger("0.30", "0.30")).not.toThrow();
    expect(() => assertTotalCoversLedger("0.29", "0.30")).toThrow(BadRequestError);
  });
});

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

  it("is fully_paid when the recorded decimal sum meets the total exactly", () => {
    expect(derivePaymentStatus("0.30", "0.30")).toBe("fully_paid");
  });

  it("treats a zero-total order as unpaid", () => {
    expect(derivePaymentStatus(0, 0)).toBe("unpaid");
  });
});
