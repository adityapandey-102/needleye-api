/**
 * The single registry of stable application error codes. Every error the API
 * returns carries one in its `{ error, code, details? }` body, and **clients
 * branch on the code, never on the message** -- messages are free to change
 * for humans; codes are the contract and must stay stable.
 *
 * Grouped by area. Generic HTTP-shaped codes (VALIDATION_ERROR, INTERNAL,
 * ROUTE_NOT_FOUND) cover the cases with no more specific meaning; everything
 * a client might reasonably want to distinguish gets its own code.
 *
 * Adding an error? Add its code here first, then reference it at the throw
 * site -- don't inline a string literal.
 */
export const ERROR_CODES = {
  // -- Generic / cross-cutting ------------------------------------------------
  VALIDATION_ERROR: "VALIDATION_ERROR",
  VALIDATION_NO_FIELDS: "VALIDATION_NO_FIELDS",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  DATABASE_ERROR: "DATABASE_ERROR",
  INTERNAL: "INTERNAL",

  // -- Auth / session ---------------------------------------------------------
  AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
  AUTH_SESSION_INVALID: "AUTH_SESSION_INVALID",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_LINK_INVALID: "AUTH_LINK_INVALID",
  AUTH_QR_INVALID: "AUTH_QR_INVALID",
  AUTH_PROFILE_MISSING: "AUTH_PROFILE_MISSING",
  AUTH_ACCOUNT_DEACTIVATED: "AUTH_ACCOUNT_DEACTIVATED",
  AUTH_BOOTSTRAP_ALREADY_DONE: "AUTH_BOOTSTRAP_ALREADY_DONE",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",

  // -- Orders -----------------------------------------------------------------
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_EDIT_FORBIDDEN: "ORDER_EDIT_FORBIDDEN",
  ORDER_NOT_ASSIGNED: "ORDER_NOT_ASSIGNED",
  ORDER_STATUS_TRANSITION_FORBIDDEN: "ORDER_STATUS_TRANSITION_FORBIDDEN",
  ORDER_PAYMENT_MISMATCH: "ORDER_PAYMENT_MISMATCH",
  /** Edit would set total_amount below the sum already recorded in the ledger (would create an "overpaid" order). */
  ORDER_TOTAL_BELOW_PAID: "ORDER_TOTAL_BELOW_PAID",
  /** Optimistic-lock conflict: the order was modified by someone else since it was loaded. */
  ORDER_MODIFIED: "ORDER_MODIFIED",

  // -- Images -----------------------------------------------------------------
  IMAGE_INVALID_SLOT: "IMAGE_INVALID_SLOT",
  IMAGE_MISSING: "IMAGE_MISSING",
  IMAGE_INVALID_TYPE: "IMAGE_INVALID_TYPE",

  // -- Payments ---------------------------------------------------------------
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  PAYMENT_NOT_ASSIGNED: "PAYMENT_NOT_ASSIGNED",
  PAYMENT_LEDGER_MISMATCH: "PAYMENT_LEDGER_MISMATCH",
  /** A payment would push the ledger sum above the order total (overpayment). */
  PAYMENT_EXCEEDS_TOTAL: "PAYMENT_EXCEEDS_TOTAL",

  // -- Users ------------------------------------------------------------------
  USER_NOT_FOUND: "USER_NOT_FOUND",
  USER_CANNOT_DEACTIVATE_SELF: "USER_CANNOT_DEACTIVATE_SELF",
  USER_PASSWORD_SELF_MANAGED: "USER_PASSWORD_SELF_MANAGED",
  USER_QR_ROLE_UNSUPPORTED: "USER_QR_ROLE_UNSUPPORTED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
