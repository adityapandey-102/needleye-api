import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { PaymentStatus } from "../../../domain";

/** Cent-rounding so float noise (0.1 + 0.2) never tips a boundary comparison. */
function cents(amount: number): number {
  return Math.round((Number(amount) || 0) * 100);
}

/**
 * The order total can never be set below what's already been recorded in the
 * ledger -- that would leave the customer "overpaid" (paid more than the order
 * is worth) and silently inflate collected revenue. The mirror of the
 * overpayment guard on the payment side (assertDoesNotExceedTotal): together
 * they keep `sum(ledger) <= total_amount` true from both directions, so an
 * overpaid state is impossible. To lower a total below the collected sum, the
 * excess payment must be reduced/removed first (i.e. the refund is recorded in
 * the ledger). Throws BadRequestError (400) with both figures for the UI.
 */
export function assertTotalCoversLedger(newTotalAmount: number, paymentsSum: number): void {
  if (cents(paymentsSum) <= cents(newTotalAmount)) return;

  throw new BadRequestError(
    `Cannot set the total to ₹${Math.round(cents(newTotalAmount)) / 100}: ₹${Math.round(cents(paymentsSum)) / 100} ` +
      `has already been recorded in the payment ledger. Reduce or remove a payment first (e.g. record the refund), ` +
      `then lower the total.`,
    ERROR_CODES.ORDER_TOTAL_BELOW_PAID,
  );
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
