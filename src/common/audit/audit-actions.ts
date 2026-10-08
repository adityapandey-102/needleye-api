/**
 * Registry of the actions `audit_log` records. Like ERROR_CODES, these strings
 * are a stable vocabulary -- reports group by them -- so add new ones here
 * rather than inlining a literal at a call site.
 *
 * Since ADR 0008 (phase 3) audit_log holds sign-ins and account events only.
 * Order, stage, price and payment changes have their own typed logs, written in
 * the same transaction as the change: order_audit_log, order_status_history,
 * order_price_history, payment_audit_log. (Older order.* / payment.* rows stay
 * in audit_log untouched; their content was copied into those logs.)
 *
 * Convention: `<entity>.<verb>` in past tense-ish dotted form.
 */
export const AUDIT_ACTIONS = {
  // Auth / session
  AUTH_LOGIN: "auth.login",
  AUTH_LOGOUT: "auth.logout",
  AUTH_PASSWORD_CHANGED: "auth.password_changed",

  // Users / accounts (Owner/Manager administration)
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_DEACTIVATED: "user.deactivated",
  USER_REACTIVATED: "user.reactivated",
  USER_PASSWORD_REGENERATED: "user.password_regenerated",
  USER_QR_GENERATED: "user.qr_generated",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Entity types an audit record can reference. */
export const AUDIT_ENTITIES = {
  USER: "user",
  SESSION: "session",
} as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];
