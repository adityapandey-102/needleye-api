import { z } from "zod";
import { createOrderDtoSchema } from "./create-order.dto";

/**
 * Edit Order: everything optional (partial update), except the fields an
 * editor is not permitted to touch -- that's enforced by the capability
 * matrix in the service layer, not by this schema (a role-agnostic shape
 * here keeps one schema instead of one per role). productionStatus is
 * accepted by the schema but the controller strips it before it reaches the
 * service -- status changes are reserved for a dedicated endpoint that
 * enforces design-stage vs production-stage RBAC.
 *
 * `version` is the optimistic-lock token: the client echoes back the
 * `version` it loaded the order with, and the update is rejected
 * (ORDER_MODIFIED) if the order was changed by someone else since. It's not
 * a business field -- the service pulls it out and never writes it.
 */
export const updateOrderDtoSchema = createOrderDtoSchema.partial().extend({
  version: z.number().int().nonnegative().optional(),
});

export type UpdateOrderDto = Omit<z.infer<typeof updateOrderDtoSchema>, "productionStatus">;
