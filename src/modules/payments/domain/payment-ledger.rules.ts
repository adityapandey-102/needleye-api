import { BadRequestError, ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { money, moneyGreaterThan, toMoneyString, type MoneyLike } from "../../../common/money/money";
import type { PaymentStatus } from "../../../domain";

/**
 * Derives an order's payment status from its recorded ledger sum vs the order
 * total -- the single source of truth (status is never chosen by hand). A
 * small, deliberate copy of Orders' own derivePaymentStatus: Domain layers
 * don't import across modules (see docs/adr/0003-per-module-schema-ownership.md),
 * so this invariant gets its own copy here. `not_priced` (no total) ->
 * `unpaid` -> `advance_paid` -> `fully_paid`; a zero-total order is
 * `fully_paid` (nothing to collect). Decimal-exact.
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

/** No payments until the order has a price (ADR 0008) -- 409, the order has to be priced first. */
export function assertOrderPriced(totalAmount: string | null): asserts totalAmount is string {
  if (totalAmount === null) {
    throw new ConflictError("Set the order total first -- then payments can be recorded.", ERROR_CODES.PAYMENT_ORDER_NOT_PRICED);
  }
}

/** Once delivered, an order's payments are final: no edits, no deletes (ADR 0008). */
export function assertPaymentsCorrectable(productionStatus: string): void {
  if (productionStatus === "delivered") {
    throw new ConflictError(
      "This order has been delivered -- its payments can no longer be edited or deleted.",
      ERROR_CODES.PAYMENT_LOCKED_AFTER_DELIVERY,
    );
  }
}

/** A payment can't be dated in the future (the shop's today, YYYY-MM-DD strings compare as dates). */
export function assertPaidAtNotFuture(paidAt: string, shopToday: string): void {
  if (paidAt > shopToday) {
    throw new BadRequestError("A payment can't be dated in the future.", ERROR_CODES.PAYMENT_DATE_INVALID);
  }
}

/** The months a payment change touches -- its date before (edit, remove) and after (record, edit) -- each once, in order. */
export function paymentMonths(...days: (string | null | undefined)[]): string[] {
  return [...new Set(days.filter((d): d is string => Boolean(d)).map((d) => d.slice(0, 7)))].sort();
}

/** "2026-09" -> "September 2026". */
function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * No payment dated in a month whose books are closed can be added, edited or
 * removed (ADR 0008 phase 5) -- the month's cash stays what was reported. The
 * Owner can reopen the month.
 */
export function assertMonthOpen(month: string, isClosed: boolean): void {
  if (isClosed) {
    throw new ConflictError(
      `The books for ${monthName(month)} are closed -- payments dated in it can't be added, changed or removed. The Owner can reopen the month.`,
      ERROR_CODES.PAYMENT_MONTH_CLOSED,
      { month },
    );
  }
}
