import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * The Ledger Activity export covers ONE week or ONE month -- never a year. A
 * whole year of payment activity is large, and the accountant's tracking is
 * monthly/weekly anyway. 31 days is the longest calendar month.
 */
export const LEDGER_EXPORT_MAX_DAYS = 31;

/**
 * Hard ceiling on rows in one export (a busy month is a few hundred). Hitting
 * it means something is off, so we refuse rather than return a partial file.
 */
export const LEDGER_EXPORT_MAX_ROWS = 5000;

/** Inclusive day count between two YYYY-MM-DD dates (2026-06-01..2026-06-30 = 30). */
export function inclusiveDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Throws 400 unless [from, to] is a forward range of at most LEDGER_EXPORT_MAX_DAYS days. */
export function assertLedgerExportRange(from: string, to: string): void {
  if (from > to) {
    throw new BadRequestError("The export's start date is after its end date", ERROR_CODES.LEDGER_EXPORT_RANGE_INVALID);
  }
  if (inclusiveDays(from, to) > LEDGER_EXPORT_MAX_DAYS) {
    throw new BadRequestError(
      `Ledger exports cover one week or one month (at most ${LEDGER_EXPORT_MAX_DAYS} days)`,
      ERROR_CODES.LEDGER_EXPORT_RANGE_INVALID,
    );
  }
}

/** Throws 400 when a window holds more rows than one export may carry. */
export function assertLedgerExportSize(total: number): void {
  if (total > LEDGER_EXPORT_MAX_ROWS) {
    throw new BadRequestError(
      `This period has ${total} ledger entries — more than one export can hold (${LEDGER_EXPORT_MAX_ROWS}). Export by week instead.`,
      ERROR_CODES.LEDGER_EXPORT_TOO_LARGE,
    );
  }
}
