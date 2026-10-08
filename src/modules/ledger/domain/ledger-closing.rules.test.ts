import { describe, expect, it } from "vitest";
import { assertAllPriced, assertCanToggle, assertClosable, normalizeReopenReason } from "./ledger-closing.rules";
import { ERROR_CODES } from "../../../common/errors/error-codes";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return null;
}

describe("closing the books (ADR 0008 phase 5)", () => {
  it("only a month that has ended can be closed", () => {
    expect(() => assertClosable("2026-09", "2026-10")).not.toThrow();
    expect(codeOf(() => assertClosable("2026-10", "2026-10"))).toBe(ERROR_CODES.LEDGER_MONTH_NOT_FINISHED);
    expect(codeOf(() => assertClosable("2026-11", "2026-10"))).toBe(ERROR_CODES.LEDGER_MONTH_NOT_FINISHED);
    expect(codeOf(() => assertClosable("2026-9", "2026-10"))).toBe(ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
  });

  it("close needs an open month; reopen needs a closed one", () => {
    expect(() => assertCanToggle("close", false)).not.toThrow();
    expect(codeOf(() => assertCanToggle("close", true))).toBe(ERROR_CODES.LEDGER_MONTH_ALREADY_CLOSED);
    expect(() => assertCanToggle("reopen", true)).not.toThrow();
    expect(codeOf(() => assertCanToggle("reopen", false))).toBe(ERROR_CODES.LEDGER_MONTH_NOT_CLOSED);
  });

  it("every order of the month needs a price before it closes", () => {
    expect(() => assertAllPriced(12, 12)).not.toThrow();
    expect(() => assertAllPriced(12, 11)).toThrow(/1 order booked in this month has no price yet/);
    expect(codeOf(() => assertAllPriced(12, 9))).toBe(ERROR_CODES.LEDGER_MONTH_HAS_UNPRICED);
  });

  it("a reopen needs a reason", () => {
    expect(normalizeReopenReason("  CA asked to correct a cash entry ")).toBe("CA asked to correct a cash entry");
    expect(codeOf(() => normalizeReopenReason("ok"))).toBe(ERROR_CODES.LEDGER_REOPEN_REASON_REQUIRED);
    expect(codeOf(() => normalizeReopenReason(undefined))).toBe(ERROR_CODES.LEDGER_REOPEN_REASON_REQUIRED);
    expect(codeOf(() => normalizeReopenReason("x".repeat(501)))).toBe(ERROR_CODES.LEDGER_REOPEN_REASON_REQUIRED);
  });
});
