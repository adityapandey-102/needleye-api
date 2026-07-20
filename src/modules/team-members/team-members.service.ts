import type { Role } from "../../domain";
import type { TeamMembersRepository } from "./team-members.repository";
import type { TeamMembersMapper } from "./team-members.mapper";
import type { TeamMemberDto } from "./dto/team-member.dto";

export class TeamMembersService {
  constructor(
    private readonly teamMembersRepository: TeamMembersRepository,
    private readonly mapper: TeamMembersMapper,
  ) {}

  async listActive(role?: Role): Promise<TeamMemberDto[]> {
    const rows = await this.teamMembersRepository.findActive(role);
    return rows.map((row) => this.mapper.toDto(row));
  }
}
