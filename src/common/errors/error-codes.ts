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
  /** The JSON body is malformed (400). */
  MALFORMED_REQUEST: "MALFORMED_REQUEST",
  /** The body is over the route's size limit (413) -- e.g. 8 kB on the public enquiry form. */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
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
  /** Status change rejected: the flow is forward-only -- the target stage is the current one or earlier (also covers a concurrent double-advance). */
  ORDER_STATUS_NOT_FORWARD: "ORDER_STATUS_NOT_FORWARD",
  /** Status change rejected: Delivered can only follow Ready (ADR 0008). */
  ORDER_DELIVER_REQUIRES_READY: "ORDER_DELIVER_REQUIRES_READY",
  ORDER_PAYMENT_MISMATCH: "ORDER_PAYMENT_MISMATCH",
  /** Edit would set total_amount below the sum already recorded in the ledger (would create an "overpaid" order). */
  ORDER_TOTAL_BELOW_PAID: "ORDER_TOTAL_BELOW_PAID",
  /** Optimistic-lock conflict: the order was modified by someone else since it was loaded. */
  ORDER_MODIFIED: "ORDER_MODIFIED",
  /** The chosen delivery date is at capacity and the caller didn't confirm the override with the Production Manager. */
  DELIVERY_DAY_FULL: "DELIVERY_DAY_FULL",
  /** Ledger export window is backwards or longer than one month (31 days) -- exports are weekly/monthly only. */
  LEDGER_EXPORT_RANGE_INVALID: "LEDGER_EXPORT_RANGE_INVALID",
  /** Ledger export window holds more rows than one export may carry. */
  LEDGER_EXPORT_TOO_LARGE: "LEDGER_EXPORT_TOO_LARGE",

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

  // -- Leads ------------------------------------------------------------------
  LEAD_NOT_FOUND: "LEAD_NOT_FOUND",
  /** The stage change isn't allowed for this role / from this stage (see lead-status.rules.ts). */
  LEAD_STATUS_FORBIDDEN: "LEAD_STATUS_FORBIDDEN",
  /** The lead is converted / lost / discarded -- reopen it before assigning. */
  LEAD_CLOSED: "LEAD_CLOSED",
  /** The assignee isn't an active designer. */
  LEAD_ASSIGNEE_INVALID: "LEAD_ASSIGNEE_INVALID",
  /** Optimistic-lock conflict: the lead changed since it was loaded. */
  LEAD_MODIFIED: "LEAD_MODIFIED",
  /** Saving an order for a lead that can't be converted (closed, not yours, or not yet received). */
  LEAD_NOT_CONVERTIBLE: "LEAD_NOT_CONVERTIBLE",
  /** Public enquiry form: the form token is missing, tampered or expired -- reload the page. */
  ENQUIRY_FORM_EXPIRED: "ENQUIRY_FORM_EXPIRED",
  /** Public enquiry form: the human check (Cloudflare Turnstile, when switched on) failed. */
  ENQUIRY_VERIFICATION_FAILED: "ENQUIRY_VERIFICATION_FAILED",

  // -- Users ------------------------------------------------------------------
  USER_NOT_FOUND: "USER_NOT_FOUND",
  USER_CANNOT_DEACTIVATE_SELF: "USER_CANNOT_DEACTIVATE_SELF",
  USER_PASSWORD_SELF_MANAGED: "USER_PASSWORD_SELF_MANAGED",
  USER_QR_ROLE_UNSUPPORTED: "USER_QR_ROLE_UNSUPPORTED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
