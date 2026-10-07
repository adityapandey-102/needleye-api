import { money, type MoneyLike } from "../../../common/money/money";
import type { PaymentStatus } from "../../../domain";

/**
 * Derives an order's payment status from its ledger -- the single source of
 * truth now that the status is never chosen by hand. `not_priced` (no total
 * yet, ADR 0008) -> `unpaid` (nothing recorded) -> `advance_paid` (some, less
 * than the total) -> `fully_paid` (recorded sum reaches the total). A
 * zero-total order is `fully_paid`: there is nothing to collect (free work --
 * promotions, friends, design contests). Pure + decimal-exact, so it's
 * identical wherever it runs. (The total can never drop below what's collected:
 * see order-pricing.rules.ts.)
 */
export function derivePaymentStatus(paymentsSum: MoneyLike, totalAmount: MoneyLike | null): PaymentStatus {
  if (totalAmount === null) return "not_priced";
  const paid = money(paymentsSum);
  const total = money(totalAmount);
  if (total.lessThanOrEqualTo(0)) return "fully_paid";
  if (paid.lessThanOrEqualTo(0)) return "unpaid";
  if (paid.greaterThanOrEqualTo(total)) return "fully_paid";
  return "advance_paid";
}
