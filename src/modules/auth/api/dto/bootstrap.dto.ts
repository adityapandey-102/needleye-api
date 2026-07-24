import { z } from "zod";

export const bootstrapDtoSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().trim().min(1),
});

export type BootstrapDto = z.infer<typeof bootstrapDtoSchema>;
