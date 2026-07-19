import { z } from "zod";
import { PAYMENT_METHOD_VALUES } from "../constants/productCategories";

export const createPaymentSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than 0"),
  method: z.enum(PAYMENT_METHOD_VALUES),
  paidAt: z.string().min(1).optional(),
  notes: z.string().trim().max(500).optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const updatePaymentSchema = createPaymentSchema.partial();

export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;
