import { describe, expect, it } from "vitest";
import { assertCanTransitionStatus } from "./order-status.rules";
import { ForbiddenError } from "../../../common/errors/app-error";
import type { StatusTransitionOwners } from "./order-status.rules";

const order: StatusTransitionOwners = { designerId: "designer-1", masterTailorId: "master-1" };

describe("assertCanTransitionStatus", () => {
  it("lets owner_manager move any order into any stage", () => {
    expect(() => assertCanTransitionStatus("owner_manager", "design_approved", order, "anyone")).not.toThrow();
    expect(() => assertCanTransitionStatus("owner_manager", "cutting", order, "anyone")).not.toThrow();
  });

  it("lets the assigned designer move their own order between design stages", () => {
    expect(() => assertCanTransitionStatus("designer", "design_approved", order, "designer-1")).not.toThrow();
  });

  it("forbids a designer moving a design-stage order they are not assigned to", () => {
    expect(() => assertCanTransitionStatus("designer", "design_approved", order, "designer-2")).toThrow(ForbiddenError);
  });

  it("forbids a designer from ever moving an order into a production stage", () => {
    expect(() => assertCanTransitionStatus("designer", "cutting", order, "designer-1")).toThrow(ForbiddenError);
  });

  it("lets the assigned master tailor move their own order between production stages", () => {
    expect(() => assertCanTransitionStatus("master_tailor", "stitching", order, "master-1")).not.toThrow();
  });

  it("forbids a master tailor moving a production-stage order they are not assigned to", () => {
    expect(() => assertCanTransitionStatus("master_tailor", "stitching", order, "master-2")).toThrow(ForbiddenError);
  });

  it("forbids a master tailor from ever moving an order into a design stage", () => {
    expect(() => assertCanTransitionStatus("master_tailor", "design_pending", order, "master-1")).toThrow(ForbiddenError);
  });

  it("forbids accountant from transitioning status at all", () => {
    expect(() => assertCanTransitionStatus("accountant", "design_pending", order, "anyone")).toThrow(ForbiddenError);
    expect(() => assertCanTransitionStatus("accountant", "cutting", order, "anyone")).toThrow(ForbiddenError);
  });
});
