import { describe, expect, it } from "vitest";
import { addMonths, assertExportable, assertMonthRange, isMonth, monthCount, monthsPage } from "./ledger-month.rules";
import { ERROR_CODES } from "../../../common/errors/error-codes";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return null;
}

describe("ledger month maths", () => {
  it("validates YYYY-MM and steps across years", () => {
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-12", 2)).toBe("2026-02");
    expect(monthCount("2020-01", "2026-10")).toBe(82);
    expect(monthCount("2026-10", "2026-10")).toBe(1);
  });

  it("pages months newest first", () => {
    expect(monthsPage("2025-11", "2026-02", 0, 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(monthsPage("2025-11", "2026-02", 3, 3)).toEqual(["2025-11"]);
    expect(monthsPage("2025-11", "2026-02", 9, 3)).toEqual([]);
  });

  it("accepts a real range up to this month; refuses the rest", () => {
    expect(() => assertMonthRange("2020-01", "2026-10", "2026-10")).not.toThrow();
    for (const [from, to] of [
      ["2026-05", "2026-04"],
      ["1999-12", "2026-01"],
      ["2026-01", "2026-11"],
      ["2026-1", "2026-02"],
    ]) {
      expect(codeOf(() => assertMonthRange(from!, to!, "2026-10")), `${from}..${to}`).toBe(ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
    }
  });

  it("caps an export at 240 months", () => {
    expect(() => assertExportable("2007-01", "2026-12")).not.toThrow();
    expect(() => assertExportable("2006-12", "2026-12")).toThrow(/at most 240 months/);
  });
});
