import { getCapabilityScope } from "../../../domain";
import { ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

/** Pricing/assignment fields are gated by a separate capability from every other editable field. */
const PRICING_FIELDS = new Set(["totalAmount", "designerId", "masterTailorId"]);

export interface FieldEditDecision {
  needsOwnershipCheck: boolean;
}

/**
 * RBAC field-splitting for order edits: pricing/assignment fields require
 * `orders:edit:pricing_assignment`; every other field requires
 * `orders:edit:customer_product_fields`. Throws if the caller's role can't
 * touch a field bucket the request actually submitted. Returns whether an
 * ownership check is still needed, for whichever scope came back "assigned"
 * rather than a flat true/false.
 */
export function assertFieldsEditable(role: Role, submittedKeys: string[]): FieldEditDecision {
  const customerProductScope = getCapabilityScope(role, "orders:edit:customer_product_fields");
  const pricingScope = getCapabilityScope(role, "orders:edit:pricing_assignment");

  const touchesPricing = submittedKeys.some((k) => PRICING_FIELDS.has(k));
  const touchesCustomerProduct = submittedKeys.some((k) => !PRICING_FIELDS.has(k));

  if (touchesPricing && pricingScope === false) {
    throw new ForbiddenError("Your role cannot edit pricing or assignment fields", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }
  if (touchesCustomerProduct && customerProductScope === false) {
    throw new ForbiddenError("Your role cannot edit order details", ERROR_CODES.ORDER_EDIT_FORBIDDEN);
  }

  const needsOwnershipCheck =
    (touchesPricing && pricingScope === "assigned") || (touchesCustomerProduct && customerProductScope === "assigned");

  return { needsOwnershipCheck };
}

/** A scoped ("assigned") edit is only allowed on the caller's own order -- shared by updateOrder and the image upload/delete flows. */
export function assertOwnershipForScopedEdit(designerId: string, callerId: string): void {
  if (designerId !== callerId) {
    throw new ForbiddenError("You can only edit orders assigned to you", ERROR_CODES.ORDER_NOT_ASSIGNED);
  }
}
