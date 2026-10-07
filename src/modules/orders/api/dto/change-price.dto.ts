import { z } from "zod";
import Decimal from "decimal.js";
import { moneyField } from "../../../../common/money/money-schema";
import { PRICE_REASON_MAX } from "../../domain/order-pricing.rules";

/** numeric(12, 2) holds at most 9,999,999,999.99. */
const MAX_TOTAL = new Decimal("9999999999.99");

/**
 * PUT /orders/:id/price -- the ONLY way an order's total changes (ADR 0008).
 * The server decides from the order's current state whether this is the first
 * price ("set"), a raise or a discount; raise and discount need a reason.
 */
export const changePriceDtoSchema = z.object({
  totalAmount: moneyField.refine((v) => new Decimal(v).lessThanOrEqualTo(MAX_TOTAL), "That total is too large"),
  reason: z.string().trim().max(PRICE_REASON_MAX).optional(),
});

export type ChangePriceDto = z.infer<typeof changePriceDtoSchema>;
