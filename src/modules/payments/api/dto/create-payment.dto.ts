import { z } from "zod";
import { PAYMENT_METHOD_VALUES } from "../../../../domain";

export const createPaymentDtoSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  method: z.enum(PAYMENT_METHOD_VALUES),
  paidAt: z.string().min(1).optional(),
  notes: z.string().trim().optional(),
  // When an outstanding balance remains after this payment, the date the next
  // one is expected (payment-due tracking). Null clears the schedule; omitted
  // leaves it unchanged. Ignored once the order is fully paid (always cleared).
  nextPaymentDate: z.string().min(1).nullable().optional(),
});

export type CreatePaymentDto = z.infer<typeof createPaymentDtoSchema>;
