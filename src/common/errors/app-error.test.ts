import { describe, expect, it } from "vitest";
import { AppError, InternalError } from "./app-error";

describe("AppError cause propagation", () => {
  it("carries no cause when none is given", () => {
    const err = new AppError(400, "Bad request", "BAD_REQUEST");
    expect(err.cause).toBeUndefined();
  });

  it("attaches the original error as `cause` when given", () => {
    const original = new Error("connection refused");
    const err = new AppError(500, "Failed", "INTERNAL", undefined, original);
    expect(err.cause).toBe(original);
  });

  it("InternalError forwards its cause to AppError", () => {
    const original = new Error("duplicate key value violates unique constraint");
    const err = new InternalError("Failed to create order", original);
    expect(err.cause).toBe(original);
    expect(err.statusCode).toBe(500);
    expect(err.details).toBeUndefined(); // cause must never leak into `details` (which can reach the client)
  });
});
