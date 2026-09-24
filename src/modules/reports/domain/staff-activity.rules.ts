import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * The owner's "who is working" rules (Batch E, agreed 2026-09-24).
 *
 * Only shop-floor and design staff are tracked: the owner and the accountant
 * are never listed.
 */
export const TRACKED_STAFF_ROLES = ["designer", "master_tailor", "production_manager", "worker"] as const;
export type TrackedStaffRole = (typeof TRACKED_STAFF_ROLES)[number];

/**
 * How far back "working" looks, per kind of work:
 * - a designer is Working while they have CREATED an undelivered order in the
 *   last 45 days (design work starts at booking and runs long);
 * - master tailor / production manager / worker are Working while they made
 *   the MOST RECENT stage move on an undelivered order in the last 30 days --
 *   i.e. that order is currently in their hands.
 */
export const DESIGNER_WORKING_WINDOW_DAYS = 45;
export const FLOOR_WORKING_WINDOW_DAYS = 30;

export function workingWindowDays(role: TrackedStaffRole): number {
  return role === "designer" ? DESIGNER_WORKING_WINDOW_DAYS : FLOOR_WORKING_WINDOW_DAYS;
}

export type StaffStatus = "working" | "idle";

/** Working iff at least one undelivered order qualifies under the role's rule. */
export function staffStatus(openOrders: number): StaffStatus {
  return openOrders > 0 ? "working" : "idle";
}

/** The daily activity feed reaches back this many days, today included. */
export const ACTIVITY_LOOKBACK_DAYS = 7;

/** Today's date (YYYY-MM-DD) in the shop's timezone. */
export function businessToday(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The days the activity feed offers, newest first: today and the 6 before it. */
export function activityDays(today: string): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: ACTIVITY_LOOKBACK_DAYS }, (_, i) =>
    new Date(base - i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** A day outside the last 7 is refused -- the feed is a recent-activity view, not an archive. */
export function assertActivityDay(day: string, today: string): void {
  if (!activityDays(today).includes(day)) {
    throw new BadRequestError(
      `Activity is available for the last ${ACTIVITY_LOOKBACK_DAYS} days only (${activityDays(today).at(-1)} to ${today})`,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
}

/** Payment events are the accountant's ledger (Revenue & Ledger), not staff activity. */
export const EXCLUDED_ACTIVITY_PREFIXES = ["payment."] as const;

