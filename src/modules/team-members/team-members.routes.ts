import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { asyncHandler } from "../../common/http/async-handler";
import { validateQuery } from "../../common/http/validate.middleware";
import { teamMemberQueryDtoSchema, type TeamMemberQueryDto } from "./dto/team-member-query.dto";
import { TeamMembersService } from "./team-members.service";
import { SupabaseTeamMembersRepository } from "./team-members.repository";
import { TeamMembersMapper } from "./team-members.mapper";

/** Composition root for the Team Members module. */
const teamMembersService = new TeamMembersService(new SupabaseTeamMembersRepository(), new TeamMembersMapper());

export const teamMembersRouter = Router();

teamMembersRouter.use(requireAuth);

/** Lightweight lookup backing the designer/master-tailor selects and filters -- all authenticated roles can read it. */
teamMembersRouter.get(
  "/",
  validateQuery(teamMemberQueryDtoSchema),
  asyncHandler(async (req, res) => {
    const { role } = req.query as unknown as TeamMemberQueryDto;
    const members = await teamMembersService.listActive(role);
    res.json({ members });
  }),
);
