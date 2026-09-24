import { describe, expect, it } from "vitest";
import { assertCanChangeStage, assertCanSkipStages } from "./order-status.rules";
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

  it("production tier (Falls/Kutchu ... Finishing): everyone on the floor, not the accountant", () => {
    for (const status of ["falls_kutchu", "cutting", "stitching", "finishing"] as const) {
      for (const role of ["owner_manager", "designer", "master_tailor", "production_manager", "worker"] as Role[]) {
        expect(() => assertCanChangeStage(role, status)).not.toThrow();
      }
      expect(() => assertCanChangeStage("accountant", status)).toThrow(ForbiddenError);
    }
  });

  it("finalization tier (QC / Alteration / Delivered): owner / designer / PM -- not master, worker, accountant", () => {
    for (const status of ["quality_check", "alteration", "delivered"] as const) {
      for (const role of ["owner_manager", "designer", "production_manager"] as Role[]) {
        expect(() => assertCanChangeStage(role, status)).not.toThrow();
      }
      for (const role of ["master_tailor", "worker", "accountant"] as Role[]) {
        expect(() => assertCanChangeStage(role, status)).toThrow(ForbiddenError);
      }
    }
  });
});

describe("assertCanSkipStages (no jumping over a stage the role can't set)", () => {
  it("closes the gap: a designer can't jump Design Approved -> Falls/Kutchu over PM Received", () => {
    expect(() => assertCanSkipStages("designer", "design_approved", "falls_kutchu")).toThrow(ForbiddenError);
    expect(() => assertCanSkipStages("designer", "design_approved", "falls_kutchu")).toThrow(
      /past the "Production Manager Received" stage/,
    );
  });

  it("lets a role that CAN set every skipped stage jump over them", () => {
    // PM can set PM Received, so PM may jump straight past it.
    expect(() => assertCanSkipStages("production_manager", "design_approved", "falls_kutchu")).not.toThrow();
    expect(() => assertCanSkipStages("owner_manager", "design_pending", "delivered")).not.toThrow();
  });

  it("still allows ordinary floor skips (e.g. an order with no hand work)", () => {
    expect(() => assertCanSkipStages("worker", "stitching", "machine_work")).not.toThrow();
    expect(() => assertCanSkipStages("master_tailor", "production_manager_received", "cutting")).not.toThrow();
  });

  it("stops the floor jumping past a finalization stage", () => {
    // Nothing lies beyond Delivered, but a worker at Finishing can't reach past
    // QC / Alteration -- and can't set Delivered itself (assertCanChangeStage).
    expect(() => assertCanSkipStages("worker", "finishing", "delivered")).toThrow(ForbiddenError);
    expect(() => assertCanSkipStages("designer", "finishing", "delivered")).not.toThrow();
  });

  it("is a no-op for adjacent, same-stage, and backward moves (forward-only reports those)", () => {
    expect(() => assertCanSkipStages("designer", "design_pending", "design_approved")).not.toThrow();
    expect(() => assertCanSkipStages("designer", "cutting", "cutting")).not.toThrow();
    expect(() => assertCanSkipStages("designer", "cutting", "design_approved")).not.toThrow();
  });
});
