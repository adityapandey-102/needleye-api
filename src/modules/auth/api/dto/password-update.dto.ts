import { z } from "zod";

export const passwordUpdateDtoSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export type PasswordUpdateDto = z.infer<typeof passwordUpdateDtoSchema>;
