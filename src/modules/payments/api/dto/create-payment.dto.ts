import { z } from "zod";
import { PAYMENT_METHOD_VALUES } from "../../../../domain";
import { positiveMoneyField } from "../../../../common/money/money-schema";
import { isRealIsoDate } from "../../../../common/time/business-date";

export const createPaymentDtoSchema = z.object({
  // Money as a normalised 2dp string (accepts a number or string on the wire).
  amount: positiveMoneyField,
  method: z.enum(PAYMENT_METHOD_VALUES),
  // A real calendar date (YYYY-MM-DD); not in the future -- checked against the
  // shop's today in the service (ADR 0008). Omitted = the shop's today.
  paidAt: z.string().refine(isRealIsoDate, "Enter a real date (YYYY-MM-DD)").optional(),
  notes: z.string().trim().optional(),
  // When an outstanding balance remains after this payment, the date the next
  // one is expected (payment-due tracking). Null clears the schedule; omitted
  // leaves it unchanged. Ignored once the order is fully paid (always cleared).
  nextPaymentDate: z.string().min(1).nullable().optional(),
});

export type CreatePaymentDto = z.infer<typeof createPaymentDtoSchema>;
