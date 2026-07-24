import { z } from "zod";
import { GRANULAR_STATUS_VALUES } from "../../../../domain";

export const updateOrderStatusDtoSchema = z.object({
  status: z.enum(GRANULAR_STATUS_VALUES, {
    errorMap: () => ({ message: "Please select a valid status" }),
  }),
});

export type UpdateOrderStatusDto = z.infer<typeof updateOrderStatusDtoSchema>;
