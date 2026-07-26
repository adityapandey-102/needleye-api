import { describe, expect, it } from "vitest";
import { assertNoOwnerManagerExists } from "./bootstrap.rules";
import { ForbiddenError } from "../../../common/errors/app-error";

describe("assertNoOwnerManagerExists", () => {
  it("allows bootstrap on a fresh install with zero owner/manager accounts", () => {
    expect(() => assertNoOwnerManagerExists(0)).not.toThrow();
  });

  it("refuses bootstrap once an owner/manager account already exists", () => {
    expect(() => assertNoOwnerManagerExists(1)).toThrow(ForbiddenError);
  });

  it("refuses bootstrap regardless of how many owner/manager accounts exist", () => {
    expect(() => assertNoOwnerManagerExists(5)).toThrow(ForbiddenError);
  });
});
