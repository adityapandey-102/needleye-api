import { describe, expect, it } from "vitest";
import { assertPasswordCanBeRegenerated, assertRoleSupportsQrLogin } from "./account-credential.rules";
import { BadRequestError, ForbiddenError } from "../../../common/errors/app-error";

describe("assertPasswordCanBeRegenerated", () => {
  it("allows regenerating a designer's password regardless of login history", () => {
    expect(() => assertPasswordCanBeRegenerated("designer", null)).not.toThrow();
    expect(() => assertPasswordCanBeRegenerated("designer", "2026-01-01T00:00:00Z")).not.toThrow();
  });

  it("allows regenerating a master tailor's password regardless of login history", () => {
    expect(() => assertPasswordCanBeRegenerated("master_tailor", "2026-01-01T00:00:00Z")).not.toThrow();
  });

  it("allows regenerating an owner_manager/accountant password before their first login", () => {
    expect(() => assertPasswordCanBeRegenerated("owner_manager", null)).not.toThrow();
    expect(() => assertPasswordCanBeRegenerated("accountant", null)).not.toThrow();
  });

  it("forbids regenerating an owner_manager/accountant password after their first login", () => {
    expect(() => assertPasswordCanBeRegenerated("owner_manager", "2026-01-01T00:00:00Z")).toThrow(ForbiddenError);
    expect(() => assertPasswordCanBeRegenerated("accountant", "2026-01-01T00:00:00Z")).toThrow(ForbiddenError);
  });
});

describe("assertRoleSupportsQrLogin", () => {
  it("allows QR login only for master_tailor", () => {
    expect(() => assertRoleSupportsQrLogin("master_tailor")).not.toThrow();
  });

  it("forbids QR login for every other role", () => {
    expect(() => assertRoleSupportsQrLogin("owner_manager")).toThrow(BadRequestError);
    expect(() => assertRoleSupportsQrLogin("designer")).toThrow(BadRequestError);
    expect(() => assertRoleSupportsQrLogin("accountant")).toThrow(BadRequestError);
  });
});
