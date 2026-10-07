import type { Role } from "../../../domain";
import type { TeamMembersRepositoryPort } from "./ports/team-members-repository.port";
import { toTeamMemberResponseDto } from "../api/team-member.presenter";
import type { TeamMemberResponseDto } from "../api/dto/team-member.response.dto";

export class TeamMembersService {
  constructor(private readonly teamMembersRepository: TeamMembersRepositoryPort) {}

  async listActive(role?: Role, search: { q?: string; limit?: number } = {}): Promise<TeamMemberResponseDto[]> {
    const entities = await this.teamMembersRepository.findActive(role, search);
    return entities.map(toTeamMemberResponseDto);
  }
}
