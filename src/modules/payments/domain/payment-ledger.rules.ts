import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { money, moneyGreaterThan, toMoneyString, type MoneyLike } from "../../../common/money/money";
import type { PaymentStatus } from "../../../domain";

/**
 * Derives an order's payment status from its recorded ledger sum vs the order
 * total -- the single source of truth (status is never chosen by hand). A
 * small, deliberate copy of Orders' own derivePaymentStatus: Domain layers
 * don't import across modules (see docs/adr/0003-per-module-schema-ownership.md),
 * so this invariant gets its own copy here. `unpaid` -> `advance_paid` ->
 * `fully_paid`. Decimal-exact.
 */
export function derivePaymentStatus(paymentsSum: MoneyLike, totalAmount: MoneyLike): PaymentStatus {
  const paid = money(paymentsSum);
  const total = money(totalAmount);
  if (total.lessThanOrEqualTo(0) || paid.lessThanOrEqualTo(0)) return "unpaid";
  if (paid.greaterThanOrEqualTo(total)) return "fully_paid";
  return "advance_paid";
}

/**
 * A ledger's recorded payments must never exceed the order total -- you can't
 * collect more than the order is worth. Enforced on every add/update. Throws
 * BadRequestError (400) with the figures so the UI can guide the user.
 */
export function assertDoesNotExceedTotal(wouldBeSum: MoneyLike, totalAmount: MoneyLike, action = "record"): void {
  if (!moneyGreaterThan(wouldBeSum, totalAmount)) return; // wouldBeSum <= total -> fine

  throw new BadRequestError(
    `Cannot ${action} this payment: it would bring the recorded total to ₹${toMoneyString(wouldBeSum)}, ` +
      `over the order total of ₹${toMoneyString(totalAmount)}.`,
    ERROR_CODES.PAYMENT_EXCEEDS_TOTAL,
  );
}
