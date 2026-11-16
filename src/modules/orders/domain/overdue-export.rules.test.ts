import { describe, expect, it } from "vitest";
import { assertOverdueExportSize, OVERDUE_EXPORT_MAX_ROWS } from "./overdue-export.rules";

describe("assertOverdueExportSize", () => {
  it("allows up to the ceiling", () => {
    expect(() => assertOverdueExportSize(0)).not.toThrow();
    expect(() => assertOverdueExportSize(OVERDUE_EXPORT_MAX_ROWS)).not.toThrow();
  });

  it("refuses more than one export can hold", () => {
    expect(() => assertOverdueExportSize(OVERDUE_EXPORT_MAX_ROWS + 1)).toThrow(/more than one export can hold/);
  });
});
