import { BadRequestError, ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { isMonth } from "./ledger-month.rules";

/**
 * Closing the books (ADR 0008, phase 5; widened 2026-10-09). The Owner or
 * Accountant closes a finished month; from then on no payment dated in it can
 * be added, edited or removed, and no order booked in it can be added, moved
 * or repriced -- so the month's cash and its booked total stay what was
 * reported. Only the Owner reopens a month, with a reason. Every close and
 * reopen is kept.
 */
export const REOPEN_REASON_MIN = 3;
export const REOPEN_REASON_MAX = 500;

export function assertMonthParam(month: string): void {
  if (!isMonth(month)) throw new BadRequestError("Use months as YYYY-MM", ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
}

/** Only a month that has ended can be closed -- this month is still taking payments. */
export function assertClosable(month: string, currentMonth: string): void {
  assertMonthParam(month);
  if (month >= currentMonth) {
    throw new ConflictError("A month can be closed once it has ended.", ERROR_CODES.LEDGER_MONTH_NOT_FINISHED);
  }
}

/** Under the month's lock: closing needs it open, reopening needs it closed. */
export function assertCanToggle(action: "close" | "reopen", isClosed: boolean): void {
  if (action === "close" && isClosed) {
    throw new ConflictError("This month is already closed.", ERROR_CODES.LEDGER_MONTH_ALREADY_CLOSED);
  }
  if (action === "reopen" && !isClosed) {
    throw new ConflictError("This month isn't closed.", ERROR_CODES.LEDGER_MONTH_NOT_CLOSED);
  }
}

/**
 * A month can't be closed while some of its orders have no price: once it's
 * closed their price could never be set, so they could never be delivered.
 */
export function assertAllPriced(ordersBooked: number, ordersPriced: number): void {
  const unpriced = ordersBooked - ordersPriced;
  if (unpriced > 0) {
    throw new ConflictError(
      `${unpriced} ${unpriced === 1 ? "order booked in this month has" : "orders booked in this month have"} no price yet -- set ${unpriced === 1 ? "its price" : "their prices"} first, then close the month.`,
      ERROR_CODES.LEDGER_MONTH_HAS_UNPRICED,
      { unpriced },
    );
  }
}

export function normalizeReopenReason(reason: string | undefined): string {
  const trimmed = reason?.trim() ?? "";
  if (trimmed.length < REOPEN_REASON_MIN || trimmed.length > REOPEN_REASON_MAX) {
    throw new BadRequestError(
      `Say why the month is being reopened (${REOPEN_REASON_MIN}-${REOPEN_REASON_MAX} characters).`,
      ERROR_CODES.LEDGER_REOPEN_REASON_REQUIRED,
    );
  }
  return trimmed;
}
