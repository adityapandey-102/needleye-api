import { ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";

/**
 * Delivery-day capacity: at most `capacity` orders (DELIVERY_DAY_CAPACITY,
 * default 10) should share one delivery date. The count is EVERY order whose
 * due_date is that day -- no filter on production or payment status (a business
 * decision: the day's workload is judged by what was promised for it).
 *
 * Capacity is a guideline, not a wall: a creator who has checked with the
 * Production Manager can still book a full day, and that override is audited.
 */

/** How the calendar colours a day. */
export type DeliveryLoadLevel = "open" | "filling" | "full";

/**
 * The count at which a day starts "filling up" (amber): 80% of capacity,
 * rounded up -- 8 for the default 10.
 */
export function nearCapacityThreshold(capacity: number): number {
  return Math.max(1, Math.ceil(capacity * 0.8));
}

/**
 * open    -> fewer than the near threshold (blue)
 * filling -> at or above it but below capacity (amber)
 * full    -> at or above capacity: booking one more exceeds it (red)
 */
export function deliveryLoadLevel(booked: number, capacity: number): DeliveryLoadLevel {
  if (booked >= capacity) return "full";
  if (booked >= nearCapacityThreshold(capacity)) return "filling";
  return "open";
}

/**
 * Decides whether an order may be placed on `dueDate`, given how many OTHER
 * orders are already booked for it. Returns `{ overridden: true }` when the day
 * is full but the caller confirmed with the Production Manager -- the caller
 * must audit that. Throws 409 DELIVERY_DAY_FULL when the day is full and they
 * didn't.
 *
 * `previousDueDate` is the order's current date on an edit (null on create).
 * An edit that doesn't MOVE the date is never checked: the edit form resends
 * every field, and an order already sitting on a full day (e.g. booked by
 * override) must stay editable -- fixing a customer's name isn't adding a
 * delivery to that day.
 */
export function checkDeliveryDayCapacity(input: {
  dueDate: string;
  previousDueDate: string | null;
  booked: number;
  capacity: number;
  confirmedWithProductionManager: boolean;
}): { overridden: boolean } {
  const { dueDate, previousDueDate, booked, capacity, confirmedWithProductionManager } = input;
  if (previousDueDate === dueDate) return { overridden: false };
  if (booked < capacity) return { overridden: false };
  if (!confirmedWithProductionManager) {
    throw new ConflictError(
      `${dueDate} is fully booked (${booked} of ${capacity} deliveries). Choose another date, or confirm with the Production Manager to book it anyway.`,
      ERROR_CODES.DELIVERY_DAY_FULL,
      { dueDate, booked, capacity },
    );
  }
  return { overridden: true };
}
