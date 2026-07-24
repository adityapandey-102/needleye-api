import { z } from "zod";

export const loginDtoSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1, "Password is required"),
});

export type LoginDto = z.infer<typeof loginDtoSchema>;
