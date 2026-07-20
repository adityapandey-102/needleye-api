import { createOrderDtoSchema } from "./create-order.dto";

/**
 * Edit Order: everything optional (partial update), except the fields an
 * editor is not permitted to touch -- that's enforced by the capability
 * matrix in the service layer, not by this schema (a role-agnostic shape
 * here keeps one schema instead of one per role). productionStatus is
 * accepted by the schema but the controller strips it before it reaches the
 * service -- status changes are reserved for a dedicated endpoint (not yet
 * built) that enforces design-stage vs production-stage RBAC.
 */
export const updateOrderDtoSchema = createOrderDtoSchema.partial();

export type UpdateOrderDto = Omit<import("zod").infer<typeof updateOrderDtoSchema>, "productionStatus">;
