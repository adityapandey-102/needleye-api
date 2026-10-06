import { getCapabilityScope } from "../../../domain";
import { ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

/** Assignment fields are gated by their own capability (owner only). */
const ASSIGNMENT_FIELDS = new Set(["designerId", "masterTailorId"]);
/** The order total has its own capability (owner, or the order's own designer). */
const TOTAL_FIELDS = new Set(["totalAmount"]);

export interface FieldEditDecision {
  needsOwnershipCheck: boolean;
}

/**
 * RBAC field-splitting for order edits, three buckets:
 * - designer / master tailor reassignment -> `orders:edit:pricing_assignment`
 * - the total                              -> `orders:edit:total`
 * - every other field                      -> `orders:edit:customer_product_fields`
 * Throws if the caller's role can't touch a bucket the request actually
 * submitted. Returns whether an ownership check is still needed, for whichever
 * touched bucket came back "assigned" rather than a flat true/false.
 */
export function assertFieldsEditable(role: Role, submittedKeys: string[]): FieldEditDecision {
  const customerProductScope = getCapabilityScope(role, "orders:edit:customer_product_fields");
  const assignmentScope = getCapabilityScope(role, "orders:edit:pricing_assignment");
  const totalScope = getCapabilityScope(role, "orders:edit:total");

  const touchesAssignment = submittedKeys.some((k) => ASSIGNMENT_FIELDS.has(k));
  const touchesTotal = submittedKeys.some((k) => TOTAL_FIELDS.has(k));
  const touchesCustomerProduct = submittedKeys.some((k) => !ASSIGNMENT_FIELDS.has(k) && !TOTAL_FIELDS.has(k));

  if (touchesAssignment && assignmentScope === false) {
    throw new ForbiddenError("Your role cannot reassign the designer or master tailor", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }
  if (touchesTotal && totalScope === false) {
    throw new ForbiddenError("Your role cannot change the order total", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }
  if (touchesCustomerProduct && customerProductScope === false) {
    throw new ForbiddenError("Your role cannot edit order details", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }

  const needsOwnershipCheck =
    (touchesAssignment && assignmentScope === "assigned") ||
    (touchesTotal && totalScope === "assigned") ||
    (touchesCustomerProduct && customerProductScope === "assigned");

  return { needsOwnershipCheck };
}

/** A scoped ("assigned") edit is only allowed on the caller's own order -- shared by updateOrder and the image upload/delete flows. */
export function assertOwnershipForScopedEdit(designerId: string, callerId: string): void {
  if (designerId !== callerId) {
    throw new ForbiddenError("You can only edit orders assigned to you", ERROR_CODES.ORDER_NOT_ASSIGNED);
  }
}
