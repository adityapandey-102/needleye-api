import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./error-codes";

describe("ERROR_CODES registry", () => {
  it("has a unique value for every code (no accidental duplicates)", () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses SCREAMING_SNAKE_CASE values matching their keys", () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
      expect(value).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
