import type { TeamMemberEntity } from "../domain/team-member.entity";
import type { TeamMemberResponseDto } from "./dto/team-member.response.dto";

/** Domain entity -> API response DTO. Identical today; kept explicit so the two can diverge later without either leaking into the other. */
export function toTeamMemberResponseDto(entity: TeamMemberEntity): TeamMemberResponseDto {
  return { ...entity };
}
