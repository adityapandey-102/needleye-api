import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateQuery } from "../../../common/http/validate.middleware";
import { teamMemberQueryDtoSchema, type TeamMemberQueryDto } from "./dto/team-member-query.dto";
import { TeamMembersService } from "../application/team-members.service";
import { DrizzleTeamMembersRepository } from "../infrastructure/drizzle-team-members.repository";

/** Composition root for the Team Members module -- wires the concrete (Infrastructure) adapter into the Application service. */
const teamMembersService = new TeamMembersService(new DrizzleTeamMembersRepository());

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
