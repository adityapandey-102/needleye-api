import { BadRequestError, ConflictError, ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { CLOSED_LEAD_STATUSES, type LeadStatus } from "./lead.entity";

/**
 * Who may move a lead from which stage to which -- pure, unit-tested.
 *
 *   new ──assign──▶ assigned ──"Received"──▶ unattended ──▶ attended ⇄ follow_up
 *    │                                            │             │          │
 *    └─discard─▶ discarded                        └────────▶ lost ◀────────┘
 *                                   converted ◀── (only by saving an order)
 *
 * - "assigned" is only ever reached through the assign action, and
 *   "converted" only by saving an order for the lead (POST /orders with
 *   leadId) -- never through a plain stage change.
 * - A designer works their OWN leads forward; the owner can set any open stage
 *   (acting for a designer), discard an unassigned lead, and reopen a lost or
 *   discarded one.
 */
export type LeadActor = "owner" | "designer";

const DESIGNER_MOVES: Partial<Record<LeadStatus, readonly LeadStatus[]>> = {
  assigned: ["unattended"], // the "Received" tap -- clears their badge
  unattended: ["attended", "follow_up", "lost"],
  attended: ["follow_up", "lost"],
  follow_up: ["attended", "follow_up", "lost"], // follow_up -> follow_up = a new follow-up date
};

const WORKING: readonly LeadStatus[] = ["unattended", "attended", "follow_up", "lost"];
const OWNER_MOVES: Partial<Record<LeadStatus, readonly LeadStatus[]>> = {
  new: ["discarded"],
  assigned: WORKING,
  unattended: WORKING,
  attended: WORKING,
  follow_up: WORKING,
  lost: ["unattended"], // reopen (back to the same designer)
  discarded: ["new"], // restore (back to the unassigned pile)
};

/** The stages `actor` may move a lead to from `from` (empty when there are none). */
export function allowedNextStatuses(actor: LeadActor, from: LeadStatus): readonly LeadStatus[] {
  return (actor === "owner" ? OWNER_MOVES : DESIGNER_MOVES)[from] ?? [];
}

export interface StatusChangeInput {
  actor: LeadActor;
  from: LeadStatus;
  to: LeadStatus;
  /** Whether the lead has a designer (reopening a lost lead needs one to go back to). */
  hasAssignee: boolean;
  lostReason?: string | null;
}

/** Throws unless the change is allowed; returns nothing. */
export function assertStatusChange({ actor, from, to, hasAssignee, lostReason }: StatusChangeInput): void {
  if (to === "converted") {
    throw new BadRequestError("A lead becomes Converted by saving an order for it", ERROR_CODES.LEAD_STATUS_FORBIDDEN);
  }
  if (to === "assigned") {
    throw new BadRequestError("Use Assign to give the lead to a designer", ERROR_CODES.LEAD_STATUS_FORBIDDEN);
  }
  if (!allowedNextStatuses(actor, from).includes(to)) {
    const who = actor === "owner" ? "The owner" : "A designer";
    throw new ForbiddenError(`${who} can't move a lead from ${from} to ${to}`, ERROR_CODES.LEAD_STATUS_FORBIDDEN);
  }
  if (from === "lost" && to === "unattended" && !hasAssignee) {
    throw new ConflictError("This lead has no designer to reopen it for — assign it instead", ERROR_CODES.LEAD_STATUS_FORBIDDEN);
  }
  if (to === "lost" && !(lostReason && lostReason.trim().length >= 2)) {
    throw new BadRequestError("Say briefly why the lead was lost", ERROR_CODES.VALIDATION_ERROR);
  }
}

/** Contacting the customer (or closing the lead) settles a repeat enquiry: urgent is cleared. */
export function clearsUrgent(to: LeadStatus): boolean {
  return to === "attended" || to === "follow_up" || CLOSED_LEAD_STATUSES.includes(to);
}

/** A lead can be (re)assigned while it's still open. */
export function assertAssignable(status: LeadStatus): void {
  if (CLOSED_LEAD_STATUSES.includes(status)) {
    throw new ConflictError("A converted, lost or discarded lead can't be assigned — reopen it first", ERROR_CODES.LEAD_CLOSED);
  }
}

/**
 * Stages a lead may be converted from (by saving an order). A designer must
 * have received it first; the owner may convert any open lead.
 */
export function convertibleFrom(actor: LeadActor): readonly LeadStatus[] {
  return actor === "owner" ? ["new", "assigned", "unattended", "attended", "follow_up"] : ["unattended", "attended", "follow_up"];
}

/**
 * A second public enquiry from the same phone reopens a closed lead so it gets
 * contacted: discarded -> back to the owner as New; lost -> back to its
 * designer as Unattended; converted stays converted (it's flagged urgent only).
 */
export function statusAfterRepeatEnquiry(current: LeadStatus, hasAssignee: boolean): LeadStatus {
  if (current === "discarded") return "new";
  if (current === "lost") return hasAssignee ? "unattended" : "new";
  return current;
}
