import { describe, expect, it } from "vitest";
import { assertOrderCanBeMarkedFullyPaid } from "./order-ledger.rules";
import { ConflictError } from "../../../common/errors/app-error";

describe("assertOrderCanBeMarkedFullyPaid", () => {
  it("allows marking fully paid when the ledger sum exactly matches the total", () => {
    expect(() => assertOrderCanBeMarkedFullyPaid(5000, 5000)).not.toThrow();
  });

  it("rejects marking fully paid when the ledger sum falls short of the total", () => {
    expect(() => assertOrderCanBeMarkedFullyPaid(4000, 5000)).toThrow(ConflictError);
  });

  it("rejects marking fully paid when the ledger sum exceeds the total", () => {
    expect(() => assertOrderCanBeMarkedFullyPaid(5500, 5000)).toThrow(ConflictError);
  });

  it("tolerates floating-point rounding noise at the paise/cent level", () => {
    expect(() => assertOrderCanBeMarkedFullyPaid(0.1 + 0.2, 0.3)).not.toThrow();
  });
});
