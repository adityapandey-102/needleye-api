import {
  GRANULAR_STATUS_VALUES,
  getCapabilityScope,
  granularLabel,
  stageCapability,
  stageIndex,
  stageMoveRefusal,
} from "../../../domain";
import { ConflictError, ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { GranularStatus, Role } from "../../../domain";

/**
 * Stage-tier RBAC for status transitions. Which roles may move an order INTO a
 * given stage is decided purely by that stage's capability tier:
 *   - design         (Design Pending, Design Approved)            -> owner / designer / PM
 *   - pm_received    (Production Manager Received)                -> owner / PM
 *   - production     (Falls/Kutchu ... Finishing)                 -> owner / designer / PM / master / worker
 *   - finalization   (Quality Check / Trail, Alteration, Delivered) -> owner / designer / PM
 *
 * Assignment is deliberately NOT considered: on the shop floor whoever
 * physically receives the garment scans it and advances the stage, so anyone in
 * the stage's tier may do it on any order.
 *
 * The flow's shape (assertStageMove), concurrency, and the no-skipping rule
 * (assertCanSkipStages) all need the order's *current* status, which must be
 * read and compared inside the same row-locked transaction that writes -- so
 * DrizzleOrdersRepository.updateStatus runs them there, not the service.
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

/**
 * A forward jump may only pass over stages the role could have set itself.
 *
 * Without this, a stage's tier was only enforced for moving INTO it, never for
 * jumping OVER it: a designer could go Design Approved -> Falls/Kutchu and skip
 * Production Manager Received entirely, even though they can't set that stage.
 * This closes that gap without banning legitimate skips -- an order that needs
 * no hand work can still jump straight past Hand Work, because everyone who can
 * reach Machine Work can also set Hand Work.
 *
 * Checks only the stages strictly BETWEEN `from` and `to`; the target itself is
 * assertCanChangeStage's job. A backward or same-stage move has no stages in
 * between, so this is a no-op for it and the forward-only check reports it.
 */
export function assertCanSkipStages(role: Role, from: GranularStatus, to: GranularStatus): void {
  const fromIndex = stageIndex(from);
  const toIndex = stageIndex(to);
  for (const stage of GRANULAR_STATUS_VALUES) {
    const index = stageIndex(stage);
    if (index <= fromIndex || index >= toIndex) continue;
    if (getCapabilityScope(role, stageCapability(stage)) === false) {
      throw new ForbiddenError(
        `Your role cannot move an order past the "${granularLabel(stage)}" stage -- ` +
          `someone who can set "${granularLabel(stage)}" has to advance it first`,
        ERROR_CODES.ORDER_STATUS_TRANSITION_FORBIDDEN,
      );
    }
  }
}

/**
 * The flow's shape (ADR 0008): forward-only except Ready -> Alteration, and
 * Delivered only from Ready. Both 409s -- the move is valid in principle but
 * not from where the order is now. The database trigger
 * orders_guard_stage_change enforces the same two rules underneath.
 */
export function assertStageMove(from: GranularStatus, to: GranularStatus): void {
  switch (stageMoveRefusal(from, to)) {
    case "same_stage":
      throw new ConflictError(`This order is already at "${granularLabel(from)}".`, ERROR_CODES.ORDER_STATUS_NOT_FORWARD);
    case "deliver_requires_ready":
      throw new ConflictError(
        `This order is at "${granularLabel(from)}" -- an order can only be delivered once it's Ready.`,
        ERROR_CODES.ORDER_DELIVER_REQUIRES_READY,
      );
    case "backward":
      throw new ConflictError(
        `This order is already at "${granularLabel(from)}" -- the production flow only moves forward ` +
          `(the one way back is Ready -> Alteration).`,
        ERROR_CODES.ORDER_STATUS_NOT_FORWARD,
      );
    case null:
      return;
  }
}
