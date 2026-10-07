import type { PriceChangeKind } from "./order-pricing.rules";

/** One row of an order's price history (ADR 0008). Money as 2dp strings. */
export interface OrderPriceChangeEntity {
  id: string;
  orderId: string;
  kind: PriceChangeKind;
  /** Null for the first price ("set"). */
  previousTotal: string | null;
  newTotal: string;
  /** What had been collected when the price changed. */
  collected: string;
  reason: string | null;
  changedBy: string | null;
  changedByName: string | null;
  createdAt: string;
}
