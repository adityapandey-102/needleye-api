import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { PaymentStatus } from "../../../domain";

/** Avoids JS floating-point noise (0.1 + 0.2 !== 0.3) when comparing currency sums. */
export function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Derives an order's payment status from its recorded ledger sum vs the order
 * total -- the single source of truth (status is never chosen by hand). A
 * small, deliberate copy of Orders' own derivePaymentStatus: Domain layers
 * don't import across modules (see docs/adr/0003-per-module-schema-ownership.md),
 * so this invariant gets its own copy here rather than a cross-module
 * dependency. `unpaid` -> `advance_paid` -> `fully_paid`.
 */
export function derivePaymentStatus(paymentsSum: number, totalAmount: number): PaymentStatus {
  const paid = Math.round((Number(paymentsSum) || 0) * 100);
  const total = Math.round((Number(totalAmount) || 0) * 100);
  if (total <= 0 || paid <= 0) return "unpaid";
  if (paid >= total) return "fully_paid";
  return "advance_paid";
}

/**
 * A ledger's recorded payments must never exceed the order total -- you can't
 * collect more than the order is worth. Enforced on every add/update
 * regardless of payment_status (the fully_paid equality rule below is a
 * stricter, separate case). Throws BadRequestError (a client input problem,
 * 400) with the outstanding amount in the message so the UI can guide the user.
 */
export function assertDoesNotExceedTotal(wouldBeSum: number, totalAmount: number, action = "record"): void {
  if (roundCurrency(wouldBeSum) <= roundCurrency(totalAmount)) return;

  throw new BadRequestError(
    `Cannot ${action} this payment: it would bring the recorded total to ₹${roundCurrency(wouldBeSum)}, ` +
      `over the order total of ₹${roundCurrency(totalAmount)}.`,
    ERROR_CODES.PAYMENT_EXCEEDS_TOTAL,
  );
}
