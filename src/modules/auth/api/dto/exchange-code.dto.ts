import { z } from "zod";

export const exchangeCodeDtoSchema = z.object({
  code: z.string().min(1, "code is required"),
});

export type ExchangeCodeDto = z.infer<typeof exchangeCodeDtoSchema>;
