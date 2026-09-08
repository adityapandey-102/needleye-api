import { z } from "zod";
import Decimal from "decimal.js";
import { toMoneyString } from "./money";

function isValidAmount(v: number | string): boolean {
  try {
    return new Decimal(v).isFinite();
  } catch {
    return false;
  }
}

function atLeast(v: number | string, min: number): boolean {
  try {
    return new Decimal(v).greaterThanOrEqualTo(min);
  } catch {
    return false;
  }
}

function greaterThanZero(v: number | string): boolean {
  try {
    return new Decimal(v).greaterThan(0);
  } catch {
    return false;
  }
}

/**
 * The ONE zod field for money coming IN over the wire. Accepts a number or a
 * numeric string (so a client may send either), validates it's a real
 * non-negative amount, and normalises to the canonical 2-decimal money string
 * ("1500.00"). Everything downstream then works with strings + decimal.js.
 */
export const moneyField = z
  .union([z.number(), z.string().trim().min(1)])
  .refine(isValidAmount, "Enter a valid amount")
  .refine((v) => atLeast(v, 0), "Amount can't be negative")
  .transform((v) => toMoneyString(v));

/** Same as moneyField but must be strictly greater than 0 (e.g. a payment amount). */
export const positiveMoneyField = z
  .union([z.number(), z.string().trim().min(1)])
  .refine(isValidAmount, "Enter a valid amount")
  .refine(greaterThanZero, "Amount must be greater than 0")
  .transform((v) => toMoneyString(v));
