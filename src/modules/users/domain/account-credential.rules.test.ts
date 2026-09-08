import { describe, expect, it } from "vitest";
import { assertRoleSupportsQrLogin, roleSupportsQrLogin } from "./account-credential.rules";
import { BadRequestError } from "../../../common/errors/app-error";
import type { Role } from "../../../domain";

describe("assertRoleSupportsQrLogin", () => {
  it("allows QR login for the shop-floor roles (master_tailor, worker)", () => {
    expect(() => assertRoleSupportsQrLogin("master_tailor")).not.toThrow();
    expect(() => assertRoleSupportsQrLogin("worker")).not.toThrow();
    expect(roleSupportsQrLogin("master_tailor")).toBe(true);
    expect(roleSupportsQrLogin("worker")).toBe(true);
  });

  it("forbids QR login for the desk roles", () => {
    for (const role of ["owner_manager", "designer", "accountant", "production_manager"] as Role[]) {
      expect(() => assertRoleSupportsQrLogin(role)).toThrow(BadRequestError);
      expect(roleSupportsQrLogin(role)).toBe(false);
    }
  });
});
