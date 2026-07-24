import { z } from "zod";

export const qrLoginDtoSchema = z.object({
  token: z.string().min(1, "token is required"),
});

export type QrLoginDto = z.infer<typeof qrLoginDtoSchema>;
