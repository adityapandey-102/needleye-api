import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * The payment-overdue export (CSV / PDF) carries EVERY order whose next
 * payment date has passed, unpaged -- the owner asked for the whole list at
 * once. The live set is small (orders still owing), so one query is fine; this
 * ceiling only guards against something being badly off, and we refuse rather
 * than hand back a partial file.
 */
export const OVERDUE_EXPORT_MAX_ROWS = 5000;

/** Throws 400 when there are more overdue orders than one export may carry. */
export function assertOverdueExportSize(total: number): void {
  if (total > OVERDUE_EXPORT_MAX_ROWS) {
    throw new BadRequestError(
      `There are ${total} orders with an overdue payment — more than one export can hold (${OVERDUE_EXPORT_MAX_ROWS}).`,
      ERROR_CODES.OVERDUE_EXPORT_TOO_LARGE,
    );
  }
}
