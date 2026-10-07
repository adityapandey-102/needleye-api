import { getCapabilityScope } from "../../../domain";
import { ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

/** Assignment fields are gated by their own capability (owner only). */
const ASSIGNMENT_FIELDS = new Set(["designerId", "masterTailorId"]);

export interface FieldEditDecision {
  needsOwnershipCheck: boolean;
}

/**
 * RBAC field-splitting for order edits, two buckets:
 * - designer / master tailor reassignment -> `orders:edit:pricing_assignment`
 * - every other field                      -> `orders:edit:customer_product_fields`
 * The total is NOT an editable field: prices change only through the pricing
 * action (PUT /orders/:id/price -- see order-pricing.rules.ts, ADR 0008); the
 * service strips an unchanged total and refuses a changed one before this runs.
 * Throws if the caller's role can't touch a bucket the request actually
 * submitted. Returns whether an ownership check is still needed, for whichever
 * touched bucket came back "assigned" rather than a flat true/false.
 */
export function assertFieldsEditable(role: Role, submittedKeys: string[]): FieldEditDecision {
  const customerProductScope = getCapabilityScope(role, "orders:edit:customer_product_fields");
  const assignmentScope = getCapabilityScope(role, "orders:edit:pricing_assignment");

  const touchesAssignment = submittedKeys.some((k) => ASSIGNMENT_FIELDS.has(k));
  const touchesCustomerProduct = submittedKeys.some((k) => !ASSIGNMENT_FIELDS.has(k));

  if (touchesAssignment && assignmentScope === false) {
    throw new ForbiddenError("Your role cannot reassign the designer or master tailor", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }
  if (touchesCustomerProduct && customerProductScope === false) {
    throw new ForbiddenError("Your role cannot edit order details", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }

  const needsOwnershipCheck =
    (touchesAssignment && assignmentScope === "assigned") || (touchesCustomerProduct && customerProductScope === "assigned");

  return { needsOwnershipCheck };
}

/** A scoped ("assigned") edit is only allowed on the caller's own order -- shared by updateOrder and the image upload/delete flows. */
export function assertOwnershipForScopedEdit(designerId: string, callerId: string): void {
  if (designerId !== callerId) {
    throw new ForbiddenError("You can only edit orders assigned to you", ERROR_CODES.ORDER_NOT_ASSIGNED);
  }
}
