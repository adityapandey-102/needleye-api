import { describe, expect, it } from "vitest";
import { assertLedgerReconciles, roundCurrency } from "./payment-ledger.rules";
import { ConflictError } from "../../../common/errors/app-error";

describe("roundCurrency", () => {
  it("eliminates binary floating-point noise at 2 decimal places", () => {
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
    expect(roundCurrency(19.999999999999996)).toBe(20);
  });
});

describe("assertLedgerReconciles", () => {
  it("allows saving a payment that keeps a fully-paid order's ledger matching its total", () => {
    expect(() => assertLedgerReconciles(5000, 5000, "save this payment")).not.toThrow();
  });

  it("rejects saving a payment that would break a fully-paid order's reconciliation", () => {
    expect(() => assertLedgerReconciles(4500, 5000, "save this payment")).toThrow(ConflictError);
  });

  it("rejects removing a payment that would break a fully-paid order's reconciliation", () => {
    expect(() => assertLedgerReconciles(0, 5000, "remove this payment")).toThrow(ConflictError);
  });

  it("includes the intended action in the error message", () => {
    expect(() => assertLedgerReconciles(0, 5000, "remove this payment")).toThrow(/remove this payment/);
  });
});
