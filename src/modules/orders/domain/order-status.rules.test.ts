import { describe, expect, it } from "vitest";
import { assertCanChangeStage } from "./order-status.rules";
import { ForbiddenError } from "../../../common/errors/app-error";
import type { Role } from "../../../domain";

describe("assertCanChangeStage (stage-tier RBAC, no assignment)", () => {
  it("lets owner_manager move an order into any stage", () => {
    for (const status of ["design_pending", "production_manager_received", "cutting", "delivered"] as const) {
      expect(() => assertCanChangeStage("owner_manager", status)).not.toThrow();
    }
  });

  it("design tier (Design Pending/Approved): owner / designer / PM only", () => {
    for (const role of ["owner_manager", "designer", "production_manager"] as Role[]) {
      expect(() => assertCanChangeStage(role, "design_approved")).not.toThrow();
    }
    for (const role of ["master_tailor", "worker", "accountant"] as Role[]) {
      expect(() => assertCanChangeStage(role, "design_approved")).toThrow(ForbiddenError);
    }
  });

  it("PM-received tier: owner / PM only", () => {
    expect(() => assertCanChangeStage("owner_manager", "production_manager_received")).not.toThrow();
    expect(() => assertCanChangeStage("production_manager", "production_manager_received")).not.toThrow();
    for (const role of ["designer", "master_tailor", "worker", "accountant"] as Role[]) {
      expect(() => assertCanChangeStage(role, "production_manager_received")).toThrow(ForbiddenError);
    }
  });

  it("production tier (Falls/Kutchu ... Delivered): everyone on the floor, not the accountant", () => {
    for (const status of ["falls_kutchu", "cutting", "alteration", "delivered"] as const) {
      for (const role of ["owner_manager", "designer", "master_tailor", "production_manager", "worker"] as Role[]) {
        expect(() => assertCanChangeStage(role, status)).not.toThrow();
      }
      expect(() => assertCanChangeStage("accountant", status)).toThrow(ForbiddenError);
    }
  });
});
