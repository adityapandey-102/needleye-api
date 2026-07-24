import { getCapabilityScope } from "../../../domain";
import type { Role } from "../../../domain";

/**
 * Real (not just UI) enforcement of "master_tailor has zero payment
 * visibility": row-scoping already guarantees a Designer only ever sees
 * their own orders, so "assigned" is automatically satisfied for them --
 * only a role with a flat `false` for `payments:read` (master_tailor) needs
 * its response stripped.
 */
export function canViewPaymentFields(role: Role): boolean {
  return getCapabilityScope(role, "payments:read") !== false;
}
