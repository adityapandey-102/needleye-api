import { db } from "../database/drizzle-client";
import { logger } from "../logger/logger";
import { getRequestContext } from "../context/request-context";
import { auditLog } from "./audit-log.schema";
import type { AuditEvent, AuditLogger } from "./audit-logger";

/**
 * Writes audit records to the `audit_log` table, filling in the actor and
 * request id from the current request context so callers don't have to.
 *
 * Best-effort by design: a failure to write an audit row is logged at ERROR
 * and swallowed -- auditing must never break (or fail) the business action it
 * records. This is the one place the "never throw" guarantee of the
 * AuditLogger interface is honored.
 */
export class DrizzleAuditLogger implements AuditLogger {
  async record(event: AuditEvent): Promise<void> {
    const ctx = getRequestContext();
    try {
      await db.insert(auditLog).values({
        actorId: event.actorId ?? ctx?.userId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        requestId: ctx?.requestId ?? null,
        metadata: event.metadata ?? null,
      });
    } catch (error) {
      logger.error({ err: error, action: event.action, entityId: event.entityId }, "Failed to write audit record");
    }
  }
}

/** Module-level singleton -- manual composition root, mirrors authProvider/storageProvider. */
export const auditLogger: AuditLogger = new DrizzleAuditLogger();
