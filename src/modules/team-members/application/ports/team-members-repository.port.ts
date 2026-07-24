import type { Role } from "../../../../domain";
import type { TeamMemberEntity } from "../../domain/team-member.entity";

/** What the Application layer needs from persistence -- Application depends on this, never the concrete Drizzle adapter. */
export interface TeamMembersRepositoryPort {
  findActive(role?: Role): Promise<TeamMemberEntity[]>;
}
