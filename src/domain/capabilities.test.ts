import { describe, expect, it } from "vitest";
import { CAPABILITIES, getCapabilityScope, hasCapability, isScopedToOwnRecords } from "./capabilities";
import type { Role } from "./roles";

const ROLES: Role[] = ["owner_manager", "designer", "master_tailor", "accountant", "production_manager", "worker"];

describe("capabilities matrix", () => {
  it("defines a scope for every role on every capability", () => {
    for (const capability of CAPABILITIES) {
      for (const role of ROLES) {
        expect(getCapabilityScope(role, capability)).toBeDefined();
      }
    }
  });

  it("gives owner_manager unrestricted (true) access to everything", () => {
    for (const capability of CAPABILITIES) {
      expect(getCapabilityScope("owner_manager", capability)).toBe(true);
    }
  });

  it("never grants master_tailor payment visibility or management", () => {
    expect(getCapabilityScope("master_tailor", "payments:read")).toBe(false);
    expect(getCapabilityScope("master_tailor", "payments:manage")).toBe(false);
    expect(hasCapability("master_tailor", "payments:read")).toBe(false);
  });

  it("scopes designer payment access to their own assigned orders", () => {
    expect(getCapabilityScope("designer", "payments:manage")).toBe("assigned");
    expect(isScopedToOwnRecords("designer", "payments:manage")).toBe(true);
    expect(hasCapability("designer", "payments:manage")).toBe(true);
  });

  it("restricts pricing/assignment edits to owner_manager only", () => {
    for (const role of ["designer", "master_tailor", "accountant", "production_manager", "worker"] as Role[]) {
      expect(getCapabilityScope(role, "orders:edit:pricing_assignment")).toBe(false);
    }
  });

  it("gates each status tier by role (no assignment scope on status)", () => {
    // Design tier: owner / designer / PM.
    expect(getCapabilityScope("designer", "orders:status:design")).toBe(true);
    expect(getCapabilityScope("production_manager", "orders:status:design")).toBe(true);
    expect(getCapabilityScope("master_tailor", "orders:status:design")).toBe(false);
    expect(getCapabilityScope("worker", "orders:status:design")).toBe(false);
    // PM-received tier: owner / PM only.
    expect(getCapabilityScope("production_manager", "orders:status:pm_received")).toBe(true);
    expect(getCapabilityScope("designer", "orders:status:pm_received")).toBe(false);
    expect(getCapabilityScope("master_tailor", "orders:status:pm_received")).toBe(false);
    // Production tier: everyone on the floor (not accountant).
    for (const role of ["owner_manager", "designer", "master_tailor", "production_manager", "worker"] as Role[]) {
      expect(getCapabilityScope(role, "orders:status:production")).toBe(true);
    }
    expect(getCapabilityScope("accountant", "orders:status:production")).toBe(false);
    // Status is never "assigned"-scoped.
    for (const cap of ["orders:status:design", "orders:status:pm_received", "orders:status:production"] as const) {
      for (const role of ROLES) {
        expect(getCapabilityScope(role, cap)).not.toBe("assigned");
      }
    }
  });

  it("reserves users:manage and reports:financial for owner_manager/accountant only", () => {
    expect(hasCapability("designer", "users:manage")).toBe(false);
    expect(hasCapability("master_tailor", "users:manage")).toBe(false);
    expect(hasCapability("accountant", "users:manage")).toBe(false);
    expect(hasCapability("accountant", "reports:financial")).toBe(true);
    expect(hasCapability("designer", "reports:financial")).toBe(false);
  });

  it("reserves reports:staff for owner_manager only (not even the accountant)", () => {
    expect(hasCapability("owner_manager", "reports:staff")).toBe(true);
    expect(hasCapability("accountant", "reports:staff")).toBe(false);
    expect(hasCapability("designer", "reports:staff")).toBe(false);
    expect(hasCapability("master_tailor", "reports:staff")).toBe(false);
  });
});
