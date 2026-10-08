import { ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * The nightly check (ADR 0008, phase 5) runs at 02:00 shop time. Over 26 hours
 * without one means the schedule has stopped -- the Revenue page says so.
 */
export const NIGHTLY_OVERDUE_HOURS = 26;

export function isNightlyOverdue(lastNightlyAt: string | null, now: Date): boolean {
  if (lastNightlyAt === null) return false; // not run yet: a fresh install, not a broken schedule
  return now.getTime() - Date.parse(lastNightlyAt) > NIGHTLY_OVERDUE_HOURS * 60 * 60 * 1000;
}

/** "Verify now" while another check is running: one at a time. */
export function assertCheckRan<T>(result: T | null): asserts result is T {
  if (result === null) {
    throw new ConflictError("A check is already running -- try again in a moment.", ERROR_CODES.LEDGER_CHECK_RUNNING);
  }
}
