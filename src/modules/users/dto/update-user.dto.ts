import { z } from "zod";
import { ROLES } from "../../../domain";

export const updateUserDtoSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
});

export type UpdateUserDto = z.infer<typeof updateUserDtoSchema>;
