import { getCapabilityScope, type GranularStatus, type Role } from "../../../domain";
import { BadRequestError, ConflictError, ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { money, moneyGreaterThan, subtractMoney, toMoneyString, type MoneyLike } from "../../../common/money/money";

/**
 * Pricing rules (ADR 0008, simplified by the owner on 2026-10-09). An order
 * starts without a price; its price then changes in one of two ways, each
 * recorded in order_price_history:
 *
 *   set        -- the first price: the order's own designer, the owner or the accountant
 *   correction -- any later change, up or down, with a reason: owner or accountant.
 *                 Never below what has already been collected: to go lower,
 *                 correct or remove a payment first.
 *
 * Delivery locks nothing; the BOOKS do: while the order's booking month is
 * closed, its price can't change (the Owner can reopen the month). The
 * repository runs decidePriceChange inside the transaction that holds the
 * order's row lock and its booking month's lock, so the state it judges can't
 * change under it.
 */
export type PriceChangeKind = "set" | "correction";

/** Kinds found in price history: older rows say raise / discount -- both corrections. */
export type PriceHistoryKind = PriceChangeKind | "raise" | "discount";

export const PRICE_REASON_MIN = 3;
export const PRICE_REASON_MAX = 500;

/** The order's state as read under the row lock. */
export interface PriceState {
  currentTotal: string | null;
  designerId: string;
  /** Sum of the order's recorded payments. */
  collected: string;
  /** YYYY-MM of the order's booking date. */
  bookingMonth: string;
  /** Its books are closed (read under the month's lock). */
  bookingMonthClosed: boolean;
}

export interface PriceChangeRequest {
  role: Role;
  callerId: string;
  newTotal: string;
  reason?: string | null;
}

export interface PriceChangeDecision {
  kind: PriceChangeKind;
  /** Trimmed reason, or null (a first price needs none). */
  reason: string | null;
}

/** "set" when there's no price yet; otherwise a correction, or unchanged. */
export function classifyPriceChange(currentTotal: MoneyLike | null, newTotal: MoneyLike): PriceChangeKind | "unchanged" {
  if (currentTotal === null) return "set";
  return money(newTotal).equals(money(currentTotal)) ? "unchanged" : "correction";
}

/** "2026-09" -> "September 2026". */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * An order booked in a closed month stays as it was closed: nothing booked
 * into it or moved out of it, no price set or corrected (409). The Owner can
 * reopen the month.
 */
export function assertBookingMonthOpen(month: string, isClosed: boolean, action: "price" | "booking"): void {
  if (!isClosed) return;
  throw new ConflictError(
    action === "price"
      ? `The books for ${monthName(month)} are closed -- this order's price can't be changed. The Owner can reopen the month.`
      : `The books for ${monthName(month)} are closed -- an order can't be booked into that month or moved out of it. The Owner can reopen the month.`,
    action === "price" ? ERROR_CODES.ORDER_PRICE_MONTH_CLOSED : ERROR_CODES.ORDER_BOOKING_MONTH_CLOSED,
    { month },
  );
}

/** True if the role can make SOME price change (set on own orders, or adjust) -- the route-level gate. */
export function canChangePriceAtAll(role: Role): boolean {
  return getCapabilityScope(role, "orders:price:set") !== false || getCapabilityScope(role, "orders:price:adjust") !== false;
}

/**
 * Decides what a requested total means for this order and whether the caller
 * may make it. Throws 403 (role), 409 (delivered: locked), or 400 (unchanged,
 * missing reason, below what's collected). Pure -- the caller supplies the
 * locked state.
 */
export function decidePriceChange(request: PriceChangeRequest, state: PriceState): PriceChangeDecision {
  const { role, callerId, newTotal } = request;
  if (!canChangePriceAtAll(role)) {
    throw new ForbiddenError("Your role can't set or change an order's price", ERROR_CODES.ORDER_PRICE_FORBIDDEN);
  }

  assertBookingMonthOpen(state.bookingMonth, state.bookingMonthClosed, "price");

  const kind = classifyPriceChange(state.currentTotal, newTotal);
  if (kind === "unchanged") {
    throw new BadRequestError(`The total is already ₹${toMoneyString(newTotal)}.`, ERROR_CODES.ORDER_PRICE_UNCHANGED);
  }

  if (kind === "set") {
    const scope = getCapabilityScope(role, "orders:price:set");
    if (scope === false) {
      throw new ForbiddenError("Only the order's designer, the Owner or the Accountant can set its price", ERROR_CODES.ORDER_PRICE_FORBIDDEN);
    }
    if (scope === "assigned" && state.designerId !== callerId) {
      throw new ForbiddenError("You can only set the price of orders assigned to you", ERROR_CODES.ORDER_PRICE_FORBIDDEN);
    }
  } else if (getCapabilityScope(role, "orders:price:adjust") === false) {
    throw new ForbiddenError(
      "Once a price is set, only the Owner or the Accountant can correct it",
      ERROR_CODES.ORDER_PRICE_FORBIDDEN,
    );
  }

  const reason = request.reason?.trim() || null;
  if (kind !== "set" && (!reason || reason.length < PRICE_REASON_MIN)) {
    throw new BadRequestError("Say why the price is being corrected.", ERROR_CODES.ORDER_PRICE_REASON_REQUIRED);
  }
  if (reason && reason.length > PRICE_REASON_MAX) {
    throw new BadRequestError(`Keep the reason under ${PRICE_REASON_MAX} characters.`, ERROR_CODES.ORDER_PRICE_REASON_REQUIRED);
  }

  if (moneyGreaterThan(state.collected, newTotal)) {
    throw new BadRequestError(
      `The price can't go below what's already been collected (₹${toMoneyString(state.collected)}). ` +
        "To lower it further, correct or remove a payment first.",
      ERROR_CODES.ORDER_TOTAL_BELOW_PAID,
      { collected: toMoneyString(state.collected) },
    );
  }

  return { kind, reason };
}

/** Delivered needs a price (409). Checked under the same row lock as the stage change. */
export function assertPricedForDelivery(target: GranularStatus, total: string | null): void {
  if (target === "delivered" && total === null) {
    throw new ConflictError(
      "Set the order total first -- then this order can be marked Delivered.",
      ERROR_CODES.ORDER_PRICE_REQUIRED,
    );
  }
}

/** An order edit may resend the current total unchanged; any actual change must go through the pricing action. */
export function assertEditKeepsTotal(currentTotal: string | null, submitted: MoneyLike | null): void {
  const same =
    submitted === null ? currentTotal === null : currentTotal !== null && money(submitted).equals(money(currentTotal));
  if (!same) {
    throw new BadRequestError(
      "Change the price with Set price, Raise price or Give discount on the order page.",
      ERROR_CODES.ORDER_PRICE_USE_PRICING,
    );
  }
}
