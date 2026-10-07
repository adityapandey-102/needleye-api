import { getCapabilityScope, type GranularStatus, type Role } from "../../../domain";
import { BadRequestError, ConflictError, ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { money, moneyGreaterThan, subtractMoney, toMoneyString, type MoneyLike } from "../../../common/money/money";

/**
 * Pricing rules (ADR 0008). An order starts without a price; its price then
 * only ever changes in one of three ways, each recorded in order_price_history:
 *
 *   set      -- the first price: the order's own designer, the owner or the accountant
 *   raise    -- a higher price, with a reason: owner or accountant
 *   discount -- a lower price, with a reason: owner or accountant, never below
 *               what has already been collected (no payment is removed to make room)
 *
 * Once the order is delivered the price is locked. The repository runs
 * decidePriceChange inside the transaction that holds the order's row lock, so
 * the state it judges (current total, stage, collected) can't change under it.
 */
export type PriceChangeKind = "set" | "raise" | "discount";

export const PRICE_REASON_MIN = 3;
export const PRICE_REASON_MAX = 500;

/** The order's state as read under the row lock. */
export interface PriceState {
  currentTotal: string | null;
  productionStatus: GranularStatus;
  designerId: string;
  /** Sum of the order's recorded payments. */
  collected: string;
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

/** "set" when there's no price yet; otherwise raise / discount / unchanged by comparison. */
export function classifyPriceChange(currentTotal: MoneyLike | null, newTotal: MoneyLike): PriceChangeKind | "unchanged" {
  if (currentTotal === null) return "set";
  const cmp = money(newTotal).comparedTo(money(currentTotal));
  if (cmp > 0) return "raise";
  if (cmp < 0) return "discount";
  return "unchanged";
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

  if (state.productionStatus === "delivered") {
    throw new ConflictError("This order has been delivered -- its price is locked.", ERROR_CODES.ORDER_PRICE_LOCKED);
  }

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
      "Once a price is set, only the Owner or the Accountant can raise it or give a discount",
      ERROR_CODES.ORDER_PRICE_FORBIDDEN,
    );
  }

  const reason = request.reason?.trim() || null;
  if (kind !== "set" && (!reason || reason.length < PRICE_REASON_MIN)) {
    throw new BadRequestError(
      kind === "raise" ? "Say why the price is being raised." : "Say why the discount is being given.",
      ERROR_CODES.ORDER_PRICE_REASON_REQUIRED,
    );
  }
  if (reason && reason.length > PRICE_REASON_MAX) {
    throw new BadRequestError(`Keep the reason under ${PRICE_REASON_MAX} characters.`, ERROR_CODES.ORDER_PRICE_REASON_REQUIRED);
  }

  if (moneyGreaterThan(state.collected, newTotal)) {
    const maxDiscount = state.currentTotal === null ? "0.00" : toMoneyString(subtractMoney(state.currentTotal, state.collected));
    throw new BadRequestError(
      `The total can't go below what's already been collected (₹${toMoneyString(state.collected)}). ` +
        `The largest discount possible is ₹${maxDiscount}.`,
      ERROR_CODES.ORDER_TOTAL_BELOW_PAID,
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
