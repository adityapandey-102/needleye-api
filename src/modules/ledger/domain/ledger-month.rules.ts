import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * Calendar-month maths for the Revenue page (ADR 0008, phase 4). Months are
 * always calendar months ("YYYY-MM"); a month's days are its shop days. Pure,
 * UTC date maths on plain strings -- no timezone can shift a month.
 */

/** The earliest month the Revenue page can show. */
export const FIRST_LEDGER_MONTH = "2000-01";
/** An export (CSV / PDF) covers at most this many months -- 20 years. */
export const LEDGER_EXPORT_MAX_MONTHS = 240;
export const LEDGER_PAGE_MAX = 60;

/** "YYYY-MM" with a real month. */
export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** "2026-10" -> "2026-10-01". */
export function monthStart(month: string): string {
  return `${month}-01`;
}

/** The month `n` months after `month` (n may be negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** "2026-10-08" -> "2026-10". */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** How many months from `from` to `to`, both included. */
export function monthCount(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!) + 1;
}

/** The months from `to` back to `from`, newest first, skipping `offset` and returning at most `limit`. */
export function monthsPage(from: string, to: string, offset: number, limit: number): string[] {
  const total = monthCount(from, to);
  const months: string[] = [];
  for (let i = offset; i < Math.min(total, offset + limit); i++) months.push(addMonths(to, -i));
  return months;
}

/** A range of whole months the page can show: real months, in order, from 2000 to this month. */
export function assertMonthRange(from: string, to: string, currentMonth: string): void {
  if (!isMonth(from) || !isMonth(to)) {
    throw new BadRequestError("Use months as YYYY-MM", ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
  }
  if (from > to) {
    throw new BadRequestError("The range starts after it ends", ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
  }
  if (from < FIRST_LEDGER_MONTH || to > currentMonth) {
    throw new BadRequestError(`Pick months from ${FIRST_LEDGER_MONTH} to ${currentMonth}`, ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
  }
}

/** An export carries every month of its range, so it's capped. */
export function assertExportable(from: string, to: string): void {
  if (monthCount(from, to) > LEDGER_EXPORT_MAX_MONTHS) {
    throw new BadRequestError(
      `An export covers at most ${LEDGER_EXPORT_MAX_MONTHS} months -- pick a shorter range`,
      ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID,
    );
  }
}
