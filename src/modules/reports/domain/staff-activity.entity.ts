import type { ActivityCategory, TrackedStaffRole } from "./staff-activity.rules";

/** One tracked staff member's workload facts, as read from the database. */
export interface StaffWorkloadEntity {
  id: string;
  fullName: string;
  role: TrackedStaffRole;
  /** Undelivered orders that count as "in their hands" under the role's rule. */
  openOrders: number;
  /** When the latest of those qualifying events happened (ISO-8601 UTC), or null. */
  lastWorkAt: string | null;
  /** Their latest logged action of any kind, across every log (ISO-8601 UTC), or null if none. */
  lastSeenAt: string | null;
}

/** One row of the daily activity feed, from whichever log its category reads. */
export interface ActivityEventEntity {
  id: string;
  category: ActivityCategory;
  /**
   * What happened: order.created / order.updated / order.image_deleted,
   * price.set / price.raise / price.discount, stage.moved,
   * payment.created / payment.updated / payment.deleted,
   * lead.created / lead.enquiry_merged / lead.assigned / lead.status_changed / lead.converted,
   * or an audit_log action (auth.login, user.created, ...).
   */
  kind: string;
  /** ISO-8601 UTC. */
  at: string;
  actorName: string | null;
  actorRole: string | null;
  orderId: string | null;
  /** The order's number when the event is about an order. */
  orderNumber: string | null;
  leadId: string | null;
  leadNumber: string | null;
  /** The account's name when the event is about a user account. */
  targetName: string | null;
  /** The category's facts: an edit's changes, a price's before/after and reason, a stage's from/to, a payment's values... */
  details: Record<string, unknown> | null;
}

export type ActivityCounts = Record<ActivityCategory, number>;
