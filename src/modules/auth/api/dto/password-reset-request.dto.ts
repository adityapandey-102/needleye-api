import { z } from "zod";

export const passwordResetRequestDtoSchema = z.object({
  email: z.string().trim().email(),
});

export type PasswordResetRequestDto = z.infer<typeof passwordResetRequestDtoSchema>;
