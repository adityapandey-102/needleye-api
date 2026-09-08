import { describe, expect, it } from "vitest";
import {
  money,
  toMoneyString,
  addMoney,
  subtractMoney,
  outstanding,
  moneyGreaterThan,
  moneyGte,
  isPositiveMoney,
} from "./money";

describe("money() coercion", () => {
  it("treats null/undefined/empty as zero", () => {
    expect(money(null).toString()).toBe("0");
    expect(money(undefined).toString()).toBe("0");
    expect(money("").toString()).toBe("0");
  });

  it("falls back to zero on unparseable input rather than throwing", () => {
    expect(money("abc").toString()).toBe("0");
  });

  it("accepts strings and numbers alike", () => {
    expect(money("1500.50").toString()).toBe("1500.5");
    expect(money(1500.5).toString()).toBe("1500.5");
  });
});

describe("toMoneyString", () => {
  it("always renders exactly two decimals", () => {
    expect(toMoneyString("1000")).toBe("1000.00");
    expect(toMoneyString(1000)).toBe("1000.00");
    expect(toMoneyString("1500.5")).toBe("1500.50");
  });

  it("rounds half-up at the paisa", () => {
    expect(toMoneyString("1.005")).toBe("1.01");
    expect(toMoneyString("1.004")).toBe("1.00");
  });

  it("has no IEEE-754 drift (the whole point of decimal money)", () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004; decimals stay exact.
    expect(toMoneyString(addMoney("0.10", "0.20"))).toBe("0.30");
  });
});

describe("arithmetic", () => {
  it("adds any number of values", () => {
    expect(toMoneyString(addMoney("100.25", "200.25", "0.50"))).toBe("301.00");
  });

  it("subtracts", () => {
    expect(toMoneyString(subtractMoney("500.00", "150.25"))).toBe("349.75");
  });

  it("outstanding never goes negative", () => {
    expect(toMoneyString(outstanding("1000.00", "400.00"))).toBe("600.00");
    expect(toMoneyString(outstanding("400.00", "1000.00"))).toBe("0.00");
  });
});

describe("comparisons", () => {
  it("moneyGreaterThan / moneyGte", () => {
    expect(moneyGreaterThan("1000.01", "1000.00")).toBe(true);
    expect(moneyGreaterThan("1000.00", "1000.00")).toBe(false);
    expect(moneyGte("1000.00", "1000.00")).toBe(true);
    expect(moneyGte("999.99", "1000.00")).toBe(false);
  });

  it("isPositiveMoney", () => {
    expect(isPositiveMoney("0.01")).toBe(true);
    expect(isPositiveMoney("0.00")).toBe(false);
    expect(isPositiveMoney(null)).toBe(false);
  });
});
