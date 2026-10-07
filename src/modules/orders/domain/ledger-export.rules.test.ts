import { describe, expect, it } from "vitest";
import {
  assertLedgerExportRange,
  assertLedgerExportSize,
  inclusiveDays,
  LEDGER_EXPORT_MAX_ROWS,
} from "./ledger-export.rules";
import { BadRequestError } from "../../../common/errors/app-error";

describe("inclusiveDays", () => {
  it("counts both ends", () => {
    expect(inclusiveDays("2026-06-01", "2026-06-01")).toBe(1);
    expect(inclusiveDays("2026-06-01", "2026-06-30")).toBe(30);
    expect(inclusiveDays("2026-07-01", "2026-07-31")).toBe(31);
    expect(inclusiveDays("2028-02-01", "2028-02-29")).toBe(29); // leap year
  });
});

describe("assertLedgerExportRange", () => {
  it("accepts a week and every calendar month (31 days max)", () => {
    expect(() => assertLedgerExportRange("2026-09-28", "2026-10-04")).not.toThrow(); // a week spanning months
    expect(() => assertLedgerExportRange("2026-07-01", "2026-07-31")).not.toThrow();
    expect(() => assertLedgerExportRange("2026-02-01", "2026-02-28")).not.toThrow();
  });

  it("refuses a year, or anything past 31 days", () => {
    expect(() => assertLedgerExportRange("2026-01-01", "2026-12-31")).toThrow(BadRequestError);
    expect(() => assertLedgerExportRange("2026-07-01", "2026-08-01")).toThrow(BadRequestError); // 32 days
  });

  it("refuses a backwards range", () => {
    expect(() => assertLedgerExportRange("2026-07-10", "2026-07-01")).toThrow(BadRequestError);
  });
});

describe("assertLedgerExportSize", () => {
  it("allows up to the row ceiling, refuses past it", () => {
    expect(() => assertLedgerExportSize(LEDGER_EXPORT_MAX_ROWS)).not.toThrow();
    expect(() => assertLedgerExportSize(LEDGER_EXPORT_MAX_ROWS + 1)).toThrow(BadRequestError);
  });
});
