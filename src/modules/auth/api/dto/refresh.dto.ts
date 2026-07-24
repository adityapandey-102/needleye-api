import { z } from "zod";

export const refreshDtoSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required"),
});

export type RefreshDto = z.infer<typeof refreshDtoSchema>;
