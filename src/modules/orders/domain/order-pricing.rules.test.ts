import { describe, expect, it } from "vitest";
import {
  assertBookingMonthOpen,
  assertEditKeepsTotal,
  assertPricedForDelivery,
  classifyPriceChange,
  decidePriceChange,
  monthName,
  type PriceState,
} from "./order-pricing.rules";
import { BadRequestError, ConflictError, ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

const DESIGNER = "designer-1";
const open = { bookingMonth: "2026-10", bookingMonthClosed: false };
const unpriced: PriceState = { currentTotal: null, designerId: DESIGNER, collected: "0.00", ...open };
const priced: PriceState = { currentTotal: "10000.00", designerId: DESIGNER, collected: "4000.00", ...open };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return null;
}

describe("classifyPriceChange", () => {
  it("is 'set' with no price, else a correction (up or down) or unchanged", () => {
    expect(classifyPriceChange(null, "500.00")).toBe("set");
    expect(classifyPriceChange(null, "0.00")).toBe("set");
    expect(classifyPriceChange("500.00", "600.00")).toBe("correction");
    expect(classifyPriceChange("500.00", "499.99")).toBe("correction");
    expect(classifyPriceChange("500.00", "500")).toBe("unchanged");
  });
});

describe("decidePriceChange (ADR 0008, simplified 2026-10-09)", () => {
  it("first price: the order's own designer, the owner and the accountant", () => {
    for (const role of ["owner_manager", "accountant"] as Role[]) {
      expect(decidePriceChange({ role, callerId: "someone", newTotal: "8000.00" }, unpriced)).toEqual({ kind: "set", reason: null });
    }
    expect(decidePriceChange({ role: "designer", callerId: DESIGNER, newTotal: "8000.00" }, unpriced).kind).toBe("set");
  });

  it("first price: not another designer's order, and never the PM / master / worker", () => {
    expect(() => decidePriceChange({ role: "designer", callerId: "other", newTotal: "8000.00" }, unpriced)).toThrow(ForbiddenError);
    for (const role of ["production_manager", "master_tailor", "worker"] as Role[]) {
      expect(codeOf(() => decidePriceChange({ role, callerId: DESIGNER, newTotal: "8000.00" }, unpriced))).toBe(
        ERROR_CODES.ORDER_PRICE_FORBIDDEN,
      );
    }
  });

  it("Rs 0 is a valid first price (intentional free work)", () => {
    expect(decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "0.00" }, unpriced).kind).toBe("set");
  });

  it("a correction, up or down: owner / accountant only, with a reason", () => {
    expect(decidePriceChange({ role: "accountant", callerId: "a", newTotal: "12000.00", reason: "  Extra embroidery " }, priced)).toEqual({
      kind: "correction",
      reason: "Extra embroidery",
    });
    expect(decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "9000.00", reason: "Typed it wrong" }, priced).kind).toBe(
      "correction",
    );
    expect(() => decidePriceChange({ role: "designer", callerId: DESIGNER, newTotal: "12000.00", reason: "More work" }, priced)).toThrow(
      /only the Owner or the Accountant can correct it/,
    );
    expect(() => decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "12000.00" }, priced)).toThrow(
      /Say why the price is being corrected/,
    );
    expect(codeOf(() => decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "9000.00", reason: " ok " }, priced))).toBe(
      ERROR_CODES.ORDER_PRICE_REASON_REQUIRED,
    );
  });

  it("never below what's been collected -- correct or remove a payment first", () => {
    expect(() => decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "3999.99", reason: "Too far" }, priced)).toThrow(
      /correct or remove a payment first/,
    );
    expect(decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "4000.00", reason: "Down to paid" }, priced).kind).toBe(
      "correction",
    );
  });

  it("delivery locks nothing; a closed booking month locks the price (409)", () => {
    expect(codeOf(() => decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "10000", reason: "x" }, priced))).toBe(
      ERROR_CODES.ORDER_PRICE_UNCHANGED,
    );
    const closed: PriceState = { ...priced, bookingMonth: "2026-09", bookingMonthClosed: true };
    expect(() => decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "11000.00", reason: "Late change" }, closed)).toThrow(
      ConflictError,
    );
    expect(codeOf(() => decidePriceChange({ role: "owner_manager", callerId: "o", newTotal: "1.00" }, { ...unpriced, bookingMonthClosed: true }))).toBe(
      ERROR_CODES.ORDER_PRICE_MONTH_CLOSED,
    );
  });
});

describe("assertBookingMonthOpen", () => {
  it("names the month and what's refused", () => {
    expect(monthName("2026-09")).toBe("September 2026");
    expect(() => assertBookingMonthOpen("2026-09", false, "booking")).not.toThrow();
    expect(() => assertBookingMonthOpen("2026-09", true, "price")).toThrow(/September 2026 are closed -- this order's price can't be changed/);
    expect(codeOf(() => assertBookingMonthOpen("2026-09", true, "booking"))).toBe(ERROR_CODES.ORDER_BOOKING_MONTH_CLOSED);
  });
});

describe("assertPricedForDelivery / assertEditKeepsTotal", () => {
  it("Delivered needs a price; other stages don't", () => {
    expect(codeOf(() => assertPricedForDelivery("delivered", null))).toBe(ERROR_CODES.ORDER_PRICE_REQUIRED);
    expect(() => assertPricedForDelivery("delivered", "0.00")).not.toThrow();
    expect(() => assertPricedForDelivery("ready", null)).not.toThrow();
  });

  it("an edit may resend the same total but never change it", () => {
    expect(() => assertEditKeepsTotal("2000.00", "2000")).not.toThrow();
    expect(() => assertEditKeepsTotal(null, null)).not.toThrow();
    expect(() => assertEditKeepsTotal("2000.00", "2500.00")).toThrow(BadRequestError);
    expect(codeOf(() => assertEditKeepsTotal(null, "0.00"))).toBe(ERROR_CODES.ORDER_PRICE_USE_PRICING);
  });
});
