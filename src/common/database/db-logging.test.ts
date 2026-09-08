import { describe, expect, it } from "vitest";
import { describeDbError, dbErrorLabel } from "./db-logging";

describe("describeDbError", () => {
  it("extracts safe pg fields from a DatabaseError-shaped object", () => {
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "profiles_email_key"'), {
      code: "23505",
      severity: "ERROR",
      constraint: "profiles_email_key",
      table: "profiles",
      schema: "public",
      routine: "_bt_check_unique",
      // These carry the offending VALUES and must never be logged:
      detail: "Key (email)=(leaked@example.com) already exists.",
      where: "SQL statement ...",
    });
    const info = describeDbError(pgErr);
    expect(info).toEqual({
      code: "23505",
      severity: "ERROR",
      constraint: "profiles_email_key",
      table: "profiles",
      schema: "public",
      routine: "_bt_check_unique",
      message: 'duplicate key value violates unique constraint "profiles_email_key"',
    });
  });

  it("NEVER includes pg detail/where (they can contain customer row values)", () => {
    const pgErr = Object.assign(new Error("boom"), { code: "23505", detail: "Key (email)=(pii@x.com) already exists.", where: "row 5" });
    const info = describeDbError(pgErr);
    expect(JSON.stringify(info)).not.toContain("pii@x.com");
    expect(info).not.toHaveProperty("detail");
    expect(info).not.toHaveProperty("where");
  });

  it("recognises a connection-level Node error by its code", () => {
    const connErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54322"), { code: "ECONNREFUSED" });
    expect(describeDbError(connErr)?.code).toBe("ECONNREFUSED");
  });

  it("returns undefined for a plain, non-database error", () => {
    expect(describeDbError(new Error("just a regular error"))).toBeUndefined();
    expect(describeDbError("a string")).toBeUndefined();
    expect(describeDbError(null)).toBeUndefined();
  });
});

describe("dbErrorLabel", () => {
  it("maps common SQLSTATE + connection codes to readable labels", () => {
    expect(dbErrorLabel("23505")).toBe("unique_violation");
    expect(dbErrorLabel("23514")).toBe("check_violation");
    expect(dbErrorLabel("40P01")).toBe("deadlock_detected");
    expect(dbErrorLabel("ECONNREFUSED")).toBe("connection_refused");
  });

  it("returns undefined for an unknown code", () => {
    expect(dbErrorLabel("99999")).toBeUndefined();
    expect(dbErrorLabel(undefined)).toBeUndefined();
  });
});
