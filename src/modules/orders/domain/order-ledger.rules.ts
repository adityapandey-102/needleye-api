import type { PaymentStatus } from "../../../domain";

/** Cent-rounding so float noise (0.1 + 0.2) never tips a boundary comparison. */
function cents(amount: number): number {
  return Math.round((Number(amount) || 0) * 100);
}

/**
 * Derives an order's payment status from its ledger -- the single source of
 * truth now that the status is never chosen by hand. `unpaid` (nothing
 * recorded) -> `advance_paid` (some, but less than the total) -> `fully_paid`
 * (recorded sum reaches the total). A zero-total order is treated as `unpaid`.
 * Pure + cent-safe, so it's identical wherever it runs (order create, every
 * ledger write) and unit-testable in isolation.
 */
export function derivePaymentStatus(paymentsSum: number, totalAmount: number): PaymentStatus {
  const paid = cents(paymentsSum);
  const total = cents(totalAmount);
  if (total <= 0 || paid <= 0) return "unpaid";
  if (paid >= total) return "fully_paid";
  return "advance_paid";
}
