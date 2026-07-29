import { ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/** Avoids JS floating-point noise (0.1 + 0.2 !== 0.3) when comparing currency sums. */
export function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * The core domain invariant of this module: whenever an order is marked
 * fully_paid, its recorded ledger total must exactly equal total_amount.
 * A pure function -- no repository, no HTTP, no Express -- so it's testable
 * in complete isolation and callable from anywhere that needs to enforce
 * it (every ledger write in PaymentsService, and the status-change check
 * in OrdersService once that module is converted -- see the README's
 * "Known duplication, deferred on purpose" note).
 *
 * Throws AppError (ConflictError) directly rather than a separate
 * "domain error" type that some translation layer would map to HTTP later
 * -- a deliberate call, not an oversight: this codebase has exactly one
 * delivery mechanism (Express REST) and will not gain a second one, so a
 * parallel domain-error hierarchy would be speculative complexity with no
 * real consumer. See docs/adr/0002-repository-port-implementation-split.md
 * for the fuller reasoning.
 */
export function assertLedgerReconciles(
  wouldBeSum: number,
  totalAmount: number,
  action: "save this payment" | "remove this payment",
): void {
  if (roundCurrency(wouldBeSum) === roundCurrency(totalAmount)) return;

  throw new ConflictError(
    `Cannot ${action}: the order is marked fully paid, but this would leave the recorded total ` +
      `(₹${roundCurrency(wouldBeSum)}) not matching the order total (₹${roundCurrency(totalAmount)}). ` +
      `Change the order's payment status first if that's intentional.`,
    ERROR_CODES.PAYMENT_LEDGER_MISMATCH,
  );
}
