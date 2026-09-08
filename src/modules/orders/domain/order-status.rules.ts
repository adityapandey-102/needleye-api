import { getCapabilityScope, granularLabel, stageCapability } from "../../../domain";
import { ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { GranularStatus, Role } from "../../../domain";

/**
 * Stage-tier RBAC for status transitions. Which roles may move an order INTO a
 * given stage is decided purely by that stage's capability tier:
 *   - design            (Design Pending, Design Approved)      -> owner / designer / PM
 *   - pm_received        (Production Manager Received)          -> owner / PM
 *   - production         (Falls/Kutchu ... Delivered)           -> owner / designer / PM / master / worker
 *
 * Assignment is deliberately NOT considered: on the shop floor whoever
 * physically receives the garment scans it and advances the stage, so anyone in
 * the stage's tier may do it on any order.
 *
 * Forward-only ordering, idempotency, and concurrency are enforced atomically
 * in the repository under a row lock (DrizzleOrdersRepository.updateStatus) --
 * they need the order's *current* status, which must be read and compared inside
 * the same transaction that writes, so they can't live here.
 */
export function assertCanChangeStage(role: Role, newStatus: GranularStatus): void {
  const capability = stageCapability(newStatus);
  if (getCapabilityScope(role, capability) === false) {
    throw new ForbiddenError(
      `Your role cannot move an order into the "${granularLabel(newStatus)}" stage`,
      ERROR_CODES.ORDER_STATUS_TRANSITION_FORBIDDEN,
    );
  }
}
