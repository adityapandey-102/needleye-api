import { describe, expect, it } from "vitest";
import { checkFormToken, FORM_TOKEN_MAX_AGE_MS, issueFormToken } from "./form-token";

const SECRET = "test-secret";
const T0 = 1_800_000_000_000;

describe("enquiry form token", () => {
  it("accepts a token used after a human-plausible delay", () => {
    expect(checkFormToken(issueFormToken(SECRET, T0), SECRET, T0 + 10_000)).toBe("ok");
  });

  it("flags a form submitted faster than a person can fill it", () => {
    expect(checkFormToken(issueFormToken(SECRET, T0), SECRET, T0 + 500)).toBe("too_fast");
  });

  it("expires stale pages", () => {
    expect(checkFormToken(issueFormToken(SECRET, T0), SECRET, T0 + FORM_TOKEN_MAX_AGE_MS + 1)).toBe("expired");
  });

  it("rejects tampering, another secret, garbage and non-strings", () => {
    const token = issueFormToken(SECRET, T0);
    const [, sig] = token.split(".");
    expect(checkFormToken(`${T0 - 60_000}.${sig}`, SECRET, T0 + 10_000)).toBe("invalid"); // older timestamp, same signature
    expect(checkFormToken(token, "other-secret", T0 + 10_000)).toBe("invalid");
    for (const bad of ["", ".", "abc.def", "123", "x".repeat(500), 42, null, undefined, { token }]) {
      expect(checkFormToken(bad, SECRET, T0 + 10_000)).toBe("invalid");
    }
  });
});
