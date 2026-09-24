import type { TrackedStaffRole } from "./staff-activity.rules";

/** One tracked staff member's workload facts, as read from the database. */
export interface StaffWorkloadEntity {
  id: string;
  fullName: string;
  role: TrackedStaffRole;
  /** Undelivered orders that count as "in their hands" under the role's rule. */
  openOrders: number;
  /** When the latest of those qualifying events happened (ISO-8601 UTC), or null. */
  lastWorkAt: string | null;
  /** Their latest audited action of any kind (ISO-8601 UTC), or null if none. */
  lastSeenAt: string | null;
}

/** One audit_log row, decorated for the activity feed. */
export interface ActivityEventEntity {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  /** ISO-8601 UTC. */
  at: string;
  actorName: string | null;
  actorRole: string | null;
  /** The order's number when the event is about an order. */
  orderNumber: string | null;
  /** The account's name when the event is about a user account. */
  targetName: string | null;
  metadata: Record<string, unknown> | null;
}
