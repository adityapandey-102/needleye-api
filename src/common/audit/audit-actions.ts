/**
 * Registry of audited business actions. Like ERROR_CODES, these strings are a
 * stable vocabulary -- reports and future audit-viewing UIs group by them --
 * so add new ones here rather than inlining a literal at a call site.
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

  // Orders
  ORDER_CREATED: "order.created",
  ORDER_UPDATED: "order.updated",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_IMAGE_DELETED: "order.image_deleted",

  // Payments
  PAYMENT_CREATED: "payment.created",
  PAYMENT_UPDATED: "payment.updated",
  PAYMENT_DELETED: "payment.deleted",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Entity types an audit record can reference. */
export const AUDIT_ENTITIES = {
  USER: "user",
  ORDER: "order",
  PAYMENT: "payment",
  SESSION: "session",
} as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];
