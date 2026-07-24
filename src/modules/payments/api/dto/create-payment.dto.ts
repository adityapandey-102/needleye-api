import { z } from "zod";
import { PAYMENT_METHOD_VALUES } from "../../../../domain";

export const createPaymentDtoSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  method: z.enum(PAYMENT_METHOD_VALUES),
  paidAt: z.string().min(1).optional(),
  notes: z.string().trim().optional(),
});

export type CreatePaymentDto = z.infer<typeof createPaymentDtoSchema>;
