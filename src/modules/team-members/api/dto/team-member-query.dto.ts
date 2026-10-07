import { z } from "zod";
import { ROLES } from "../../../../domain";

/** Upper bound on a searched lookup -- a type-ahead never needs more. */
export const TEAM_MEMBER_SEARCH_MAX = 20;

export const teamMemberQueryDtoSchema = z.object({
  role: z.enum(ROLES).optional(),
  /** Optional name search (contains, case-insensitive) -- for type-ahead pickers. */
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Optional cap (max 20). Omitted = the whole active list, as before. */
  limit: z.coerce.number().int().min(1).max(TEAM_MEMBER_SEARCH_MAX).optional(),
});

export type TeamMemberQueryDto = z.infer<typeof teamMemberQueryDtoSchema>;
