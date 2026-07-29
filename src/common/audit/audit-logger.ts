import type { AuditAction, AuditEntity } from "./audit-actions";

/**
 * One audited business event. `actorId`/`requestId` are usually filled in
 * automatically from the request context by the implementation, so callers
 * normally pass just the action, entity, and (optionally) a small metadata
 * blob -- e.g. `{ from: "designer", to: "accountant" }` for a role change.
 * Keep metadata minimal; it is not a place to dump whole entities.
 */
export interface AuditEvent {
  action: AuditAction;
  entityType: AuditEntity;
  entityId?: string;
  /** Overrides the context actor -- needed for login, where the actor isn't yet on the request context. */
  actorId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The audit-logging seam. Business services depend on this interface, never
 * on where audit records actually go -- today a Postgres table
 * (DrizzleAuditLogger), swappable for an external audit sink later without
 * touching a single service. `record` never throws: a failed audit write is
 * logged and swallowed so it can't break the business operation it describes.
 */
export interface AuditLogger {
  record(event: AuditEvent): Promise<void>;
}
