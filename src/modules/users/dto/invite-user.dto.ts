import { z } from "zod";
import { ROLES } from "../../../domain";

export const inviteUserDtoSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  fullName: z.string().trim().min(1, "Please enter a full name"),
  role: z.enum(ROLES),
});

export type InviteUserDto = z.infer<typeof inviteUserDtoSchema>;
