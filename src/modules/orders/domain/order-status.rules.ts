import { DESIGN_STAGE_STATUSES, getCapabilityScope, granularLabel } from "../../../domain";
import { ForbiddenError } from "../../../common/errors/app-error";
import type { GranularStatus, Role } from "../../../domain";

/** Who owns which side of a status transition -- the fields the ownership check needs, nothing more. */
export interface StatusTransitionOwners {
  designerId: string;
  masterTailorId: string;
}

/**
 * Stage-ownership RBAC for status transitions: moving an order into a
 * design-stage status (design_pending/design_approved/fabric_purchased)
 * requires `orders:status:design_stages`; moving it into any other
 * (production-stage) status requires `orders:status:production_stages`.
 * This is what makes the design->production handoff a real workflow
 * boundary -- a Designer can freely move an order between design stages,
 * but only a Master Tailor (or Owner/Manager) can be the one who advances
 * it into cutting/stitching/etc.
 */
export function assertCanTransitionStatus(role: Role, newStatus: GranularStatus, order: StatusTransitionOwners, callerId: string): void {
  const isDesignStage = DESIGN_STAGE_STATUSES.includes(newStatus);
  const capability = isDesignStage ? "orders:status:design_stages" : "orders:status:production_stages";
  const scope = getCapabilityScope(role, capability);

  if (scope === false) {
    throw new ForbiddenError(`Your role cannot move an order into the "${granularLabel(newStatus)}" stage`);
  }
  if (scope === "assigned") {
    const ownerId = isDesignStage ? order.designerId : order.masterTailorId;
    if (ownerId !== callerId) {
      throw new ForbiddenError("You can only update the status of orders assigned to you");
    }
  }
}
