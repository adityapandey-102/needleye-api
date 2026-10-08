import { describe, expect, it } from "vitest";
import {
  assertDoesNotExceedTotal,
  assertMonthOpen,
  assertOrderPriced,
  assertPaidAtNotFuture,
  assertPaymentsCorrectable,
  derivePaymentStatus,
  paymentMonths,
} from "./payment-ledger.rules";
import { BadRequestError, ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

describe("derivePaymentStatus", () => {
  it("is unpaid at zero, advance below total, fully_paid at/above total", () => {
    expect(derivePaymentStatus("0.00", "5000.00")).toBe("unpaid");
    expect(derivePaymentStatus("2000.00", "5000.00")).toBe("advance_paid");
    expect(derivePaymentStatus("5000.00", "5000.00")).toBe("fully_paid");
  });

  it("treats a zero-total order as fully_paid (same rule as Orders)", () => {
    expect(derivePaymentStatus("0.00", "0.00")).toBe("fully_paid");
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

describe("payment rules (ADR 0008)", () => {
  it("not_priced while the order has no total", () => {
    expect(derivePaymentStatus("0.00", null)).toBe("not_priced");
  });

  it("no payment until the order is priced (409)", () => {
    expect(() => assertOrderPriced(null)).toThrow(ConflictError);
    expect(() => assertOrderPriced(null)).toThrow(/Set the order total first/);
    expect(() => assertOrderPriced("0.00")).not.toThrow();
  });

  it("payments are final once the order is delivered (409)", () => {
    expect(() => assertPaymentsCorrectable("delivered")).toThrow(ConflictError);
    expect(() => assertPaymentsCorrectable("ready")).not.toThrow();
  });

  it("a payment can't be dated after the shop's today", () => {
    expect(() => assertPaidAtNotFuture("2026-10-10", "2026-10-09")).toThrow(BadRequestError);
    expect(() => assertPaidAtNotFuture("2026-10-09", "2026-10-09")).not.toThrow();
    expect(() => assertPaidAtNotFuture("2025-12-31", "2026-10-09")).not.toThrow();
  });

  it("closed books: the months a change touches, each once, in order (ADR 0008 phase 5)", () => {
    expect(paymentMonths("2026-09-30", "2026-08-01")).toEqual(["2026-08", "2026-09"]);
    expect(paymentMonths("2026-09-30", "2026-09-01")).toEqual(["2026-09"]);
    expect(paymentMonths("2026-09-30", undefined)).toEqual(["2026-09"]);
  });

  it("closed books: no payment change in a closed month (409, names the month)", () => {
    expect(() => assertMonthOpen("2026-09", false)).not.toThrow();
    try {
      assertMonthOpen("2026-09", true);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe(ERROR_CODES.PAYMENT_MONTH_CLOSED);
      expect((error as ConflictError).message).toMatch(/September 2026 are closed/);
    }
  });
});
