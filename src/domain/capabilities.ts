import type { Role } from "./roles";

export const CAPABILITIES = [
  "orders:create",
  "orders:read",
  "orders:edit:customer_product_fields",
  "orders:edit:pricing_assignment",
  "orders:status:design_stages",
  "orders:status:production_stages",
  "payments:manage",
  "payments:read",
  "reports:financial",
  "reports:staff",
  "users:manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * `true`  -> allowed on any order.
 * `"assigned"` -> allowed only when the caller is the order's designer_id or
 *                 master_tailor_id (or, for payments, the order's designer).
 * `false` -> never allowed.
 *
 * Kept as a flat lookup table on purpose (not a generic policy engine) --
 * four roles, ten capabilities, all known up front.
 */
type CapabilityScope = boolean | "assigned";

export const CAPABILITY_MATRIX: Record<Capability, Record<Role, CapabilityScope>> = {
  "orders:create": {
    owner_manager: true,
    designer: true,
    master_tailor: false,
    accountant: false,
  },
  "orders:read": {
    owner_manager: true,
    designer: "assigned",
    master_tailor: "assigned",
    accountant: true,
  },
  "orders:edit:customer_product_fields": {
    owner_manager: true,
    designer: "assigned",
    master_tailor: false,
    accountant: false,
  },
  "orders:edit:pricing_assignment": {
    owner_manager: true,
    designer: false,
    master_tailor: false,
    accountant: false,
  },
  "orders:status:design_stages": {
    owner_manager: true,
    designer: "assigned",
    master_tailor: false,
    accountant: false,
  },
  "orders:status:production_stages": {
    owner_manager: true,
    designer: false,
    master_tailor: "assigned",
    accountant: false,
  },
  // Designer manages payments on their own orders -- they collect money from
  // the client at booking. Master Tailor has no payment visibility at all.
  "payments:manage": {
    owner_manager: true,
    designer: "assigned",
    master_tailor: false,
    accountant: true,
  },
  "payments:read": {
    owner_manager: true,
    designer: "assigned",
    master_tailor: false,
    accountant: true,
  },
  "reports:financial": {
    owner_manager: true,
    designer: false,
    master_tailor: false,
    accountant: true,
  },
  // Staff performance reports (per designer/master weekly workload) -- a
  // management view, Owner/Manager only (deliberately NOT the accountant, who
  // only gets financial reporting).
  "reports:staff": {
    owner_manager: true,
    designer: false,
    master_tailor: false,
    accountant: false,
  },
  "users:manage": {
    owner_manager: true,
    designer: false,
    master_tailor: false,
    accountant: false,
  },
};

export function getCapabilityScope(role: Role, capability: Capability): CapabilityScope {
  return CAPABILITY_MATRIX[capability][role];
}

/** True if the role has this capability at all (globally or scoped to own records). */
export function hasCapability(role: Role, capability: Capability): boolean {
  return getCapabilityScope(role, capability) !== false;
}

/** True if the role's access to this capability is limited to records assigned to them. */
export function isScopedToOwnRecords(role: Role, capability: Capability): boolean {
  return getCapabilityScope(role, capability) === "assigned";
}
