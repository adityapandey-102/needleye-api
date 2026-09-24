import { describe, expect, it } from "vitest";
import { assertRoleSupportsQrLogin, roleSupportsQrLogin } from "./account-credential.rules";
import { BadRequestError } from "../../../common/errors/app-error";
import type { Role } from "../../../domain";

describe("assertRoleSupportsQrLogin", () => {
  it("allows a QR login card for designer, master_tailor, production_manager and worker", () => {
    for (const role of ["designer", "master_tailor", "production_manager", "worker"] as Role[]) {
      expect(() => assertRoleSupportsQrLogin(role)).not.toThrow();
      expect(roleSupportsQrLogin(role)).toBe(true);
    }
  });

  it("forbids a QR login card for owner_manager and accountant (pricing/payment/staff powers)", () => {
    for (const role of ["owner_manager", "accountant"] as Role[]) {
      expect(() => assertRoleSupportsQrLogin(role)).toThrow(BadRequestError);
      expect(roleSupportsQrLogin(role)).toBe(false);
    }
  });
});
