import { describe, expect, it } from "vitest";
import { assertCheckRan, isNightlyOverdue } from "./reconciliation.rules";
import { ERROR_CODES } from "../../../common/errors/error-codes";

describe("the nightly check (ADR 0008 phase 5)", () => {
  const now = new Date("2026-10-08T12:00:00Z");

  it("is overdue after 26 hours without a nightly run -- but not before the first one", () => {
    expect(isNightlyOverdue("2026-10-07T20:30:00Z", now)).toBe(false);
    expect(isNightlyOverdue("2026-10-07T10:00:01Z", now)).toBe(false);
    expect(isNightlyOverdue("2026-10-07T09:59:59Z", now)).toBe(true);
    expect(isNightlyOverdue(null, now)).toBe(false);
  });

  it("one check at a time", () => {
    expect(() => assertCheckRan({ id: "x" })).not.toThrow();
    let code: string | undefined;
    try {
      assertCheckRan(null);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe(ERROR_CODES.LEDGER_CHECK_RUNNING);
  });
});
