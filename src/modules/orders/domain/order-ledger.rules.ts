import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { money, moneyGreaterThan, toMoneyString, type MoneyLike } from "../../../common/money/money";
import type { PaymentStatus } from "../../../domain";

/**
 * The order total can never be set below what's already been recorded in the
 * ledger -- that would leave the customer "overpaid" (paid more than the order
 * is worth) and silently inflate collected revenue. The mirror of the
 * overpayment guard on the payment side (assertDoesNotExceedTotal): together
 * they keep `sum(ledger) <= total_amount` true from both directions. To lower a
 * total below the collected sum, the excess payment must be reduced/removed
 * first (i.e. the refund is recorded in the ledger). Throws BadRequestError
 * (400) with both figures for the UI. All comparisons use decimal.js money.
 */
export function assertTotalCoversLedger(newTotalAmount: MoneyLike, paymentsSum: MoneyLike): void {
  if (!moneyGreaterThan(paymentsSum, newTotalAmount)) return; // paymentsSum <= newTotal -> fine

  throw new BadRequestError(
    `Cannot set the total to ₹${toMoneyString(newTotalAmount)}: ₹${toMoneyString(paymentsSum)} ` +
      `has already been recorded in the payment ledger. Reduce or remove a payment first (e.g. record the refund), ` +
      `then lower the total.`,
    ERROR_CODES.ORDER_TOTAL_BELOW_PAID,
  );
}

/**
 * Derives an order's payment status from its ledger -- the single source of
 * truth now that the status is never chosen by hand. `unpaid` (nothing
 * recorded) -> `advance_paid` (some, less than the total) -> `fully_paid`
 * (recorded sum reaches the total). A zero-total order is `unpaid`. Pure +
 * decimal-exact, so it's identical wherever it runs.
 */
export function derivePaymentStatus(paymentsSum: MoneyLike, totalAmount: MoneyLike): PaymentStatus {
  const paid = money(paymentsSum);
  const total = money(totalAmount);
  if (total.lessThanOrEqualTo(0) || paid.lessThanOrEqualTo(0)) return "unpaid";
  if (paid.greaterThanOrEqualTo(total)) return "fully_paid";
  return "advance_paid";
}
