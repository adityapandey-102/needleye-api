import { createPaymentDtoSchema } from "./create-payment.dto";

/** Every field optional (partial update) -- same reasoning as UpdateOrderDto. */
export const updatePaymentDtoSchema = createPaymentDtoSchema.partial();

export type UpdatePaymentDto = import("zod").infer<typeof updatePaymentDtoSchema>;
