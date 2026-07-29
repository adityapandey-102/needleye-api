import { ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * An order can only be marked fully_paid if the recorded ledger sum already
 * equals the total -- otherwise payment_status and the ledger would
 * silently disagree. A near-duplicate of Payments' own
 * assertLedgerReconciles: Domain layers don't import across modules (only
 * Infrastructure does, see docs/adr/0003-per-module-schema-ownership.md),
 * so this invariant gets its own small copy here rather than a cross-module
 * domain dependency.
 */
export function assertOrderCanBeMarkedFullyPaid(paymentsSum: number, totalAmount: number): void {
  if (Math.round(paymentsSum * 100) !== Math.round(totalAmount * 100)) {
    throw new ConflictError(
      `Cannot mark this order fully paid: the recorded payments total (₹${paymentsSum}) does not match ` +
        `the order total (₹${totalAmount}). Record the remaining payment first.`,
      ERROR_CODES.ORDER_PAYMENT_MISMATCH,
    );
  }
}
