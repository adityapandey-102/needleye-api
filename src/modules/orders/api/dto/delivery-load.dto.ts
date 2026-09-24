import { z } from "zod";

/** Widest window one request may ask for -- the calendar shows at most two months at a time, six months ahead. */
export const DELIVERY_LOAD_MAX_SPAN_DAYS = 200;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-31, which the regex alone would let through to Postgres). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Not a real date");

function spanDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** GET /orders/delivery-load?from=&to=&excludeOrderId= */
export const deliveryLoadQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    /** The order being edited -- left out so it doesn't count against its own day. */
    excludeOrderId: z.string().uuid().optional(),
  })
  .refine((q) => q.to >= q.from, { message: "`to` must not be before `from`", path: ["to"] })
  .refine((q) => spanDays(q.from, q.to) <= DELIVERY_LOAD_MAX_SPAN_DAYS, {
    message: `Ask for at most ${DELIVERY_LOAD_MAX_SPAN_DAYS} days at a time`,
    path: ["to"],
  });

export type DeliveryLoadQuery = z.infer<typeof deliveryLoadQuerySchema>;

/**
 * Per-day delivery counts plus the thresholds the calendar colours by. Only
 * days with at least one order are listed (a missing day = 0). `capacity` and
 * `nearCapacity` come from the server so the web never hard-codes them.
 */
export interface DeliveryLoadResponseDto {
  capacity: number;
  nearCapacity: number;
  days: { date: string; count: number }[];
}
