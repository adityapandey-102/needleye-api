import { z } from "zod";
import { ROLES } from "../constants/roles";

export const inviteUserSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  fullName: z.string().trim().min(1, "Please enter a full name"),
  role: z.enum(ROLES),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
