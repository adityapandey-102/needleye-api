import type { TeamMemberRow } from "./team-members.repository";
import type { TeamMemberDto } from "./dto/team-member.dto";

export class TeamMembersMapper {
  toDto(row: TeamMemberRow): TeamMemberDto {
    return { id: row.id, fullName: row.full_name, role: row.role };
  }
}
