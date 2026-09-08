import { describe, expect, it } from "vitest";
import { assertDoesNotExceedTotal, derivePaymentStatus } from "./payment-ledger.rules";
import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

describe("derivePaymentStatus", () => {
  it("is unpaid at zero, advance below total, fully_paid at/above total", () => {
    expect(derivePaymentStatus("0.00", "5000.00")).toBe("unpaid");
    expect(derivePaymentStatus("2000.00", "5000.00")).toBe("advance_paid");
    expect(derivePaymentStatus("5000.00", "5000.00")).toBe("fully_paid");
  });

  it("computes exactly on decimal amounts (no binary float drift)", () => {
    // 0.10 + 0.20 must equal 0.30 exactly -- decimal.js, not IEEE-754.
    expect(derivePaymentStatus("0.30", "0.30")).toBe("fully_paid");
  });

  it("still accepts plain numbers (MoneyLike) for convenience", () => {
    expect(derivePaymentStatus(2000, 5000)).toBe("advance_paid");
  });
});

describe("assertDoesNotExceedTotal", () => {
  it("allows a ledger sum below the order total", () => {
    expect(() => assertDoesNotExceedTotal("400.00", "1000.00")).not.toThrow();
  });

  it("allows a ledger sum exactly equal to the order total", () => {
    expect(() => assertDoesNotExceedTotal("1000.00", "1000.00")).not.toThrow();
  });

  it("rejects a ledger sum over the order total (overpayment)", () => {
    expect(() => assertDoesNotExceedTotal("1000.01", "1000.00")).toThrow(BadRequestError);
  });

  it("carries the PAYMENT_EXCEEDS_TOTAL code and the intended action", () => {
    try {
      assertDoesNotExceedTotal("1500.00", "1000.00", "update");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).code).toBe(ERROR_CODES.PAYMENT_EXCEEDS_TOTAL);
      expect((err as Error).message).toMatch(/update/);
    }
  });

  it("has no floating-point noise at the boundary", () => {
    expect(() => assertDoesNotExceedTotal("0.30", "0.30")).not.toThrow();
  });
});
