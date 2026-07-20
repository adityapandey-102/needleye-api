import { z } from "zod";
import { ROLES } from "../../../domain";

export const teamMemberQueryDtoSchema = z.object({
  role: z.enum(ROLES).optional(),
});

export type TeamMemberQueryDto = z.infer<typeof teamMemberQueryDtoSchema>;
