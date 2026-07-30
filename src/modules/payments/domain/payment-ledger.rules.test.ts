import { describe, expect, it } from "vitest";
import { assertDoesNotExceedTotal, derivePaymentStatus, roundCurrency } from "./payment-ledger.rules";
import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

describe("roundCurrency", () => {
  it("eliminates binary floating-point noise at 2 decimal places", () => {
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
    expect(roundCurrency(19.999999999999996)).toBe(20);
  });
});

describe("derivePaymentStatus", () => {
  it("is unpaid at zero, advance below total, fully_paid at/above total", () => {
    expect(derivePaymentStatus(0, 5000)).toBe("unpaid");
    expect(derivePaymentStatus(2000, 5000)).toBe("advance_paid");
    expect(derivePaymentStatus(5000, 5000)).toBe("fully_paid");
  });

  it("matches the Orders module's copy across cent rounding", () => {
    expect(derivePaymentStatus(0.1 + 0.2, 0.3)).toBe("fully_paid");
  });
});

describe("assertDoesNotExceedTotal", () => {
  it("allows a ledger sum below the order total", () => {
    expect(() => assertDoesNotExceedTotal(400, 1000)).not.toThrow();
  });

  it("allows a ledger sum exactly equal to the order total", () => {
    expect(() => assertDoesNotExceedTotal(1000, 1000)).not.toThrow();
  });

  it("rejects a ledger sum over the order total (overpayment)", () => {
    expect(() => assertDoesNotExceedTotal(1001, 1000)).toThrow(BadRequestError);
  });

  it("carries the PAYMENT_EXCEEDS_TOTAL code and the intended action", () => {
    try {
      assertDoesNotExceedTotal(1500, 1000, "update");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).code).toBe(ERROR_CODES.PAYMENT_EXCEEDS_TOTAL);
      expect((err as Error).message).toMatch(/update/);
    }
  });

  it("tolerates paise/cent floating-point noise at the boundary", () => {
    expect(() => assertDoesNotExceedTotal(0.1 + 0.2, 0.3)).not.toThrow();
  });
});
