import type { Role } from "../../../../domain";
import type { TeamMemberEntity } from "../../domain/team-member.entity";

/** What the Application layer needs from persistence -- Application depends on this, never the concrete Drizzle adapter. */
export interface TeamMembersRepositoryPort {
  /** Active staff, optionally one role, optionally name-searched and capped (type-ahead pickers). */
  findActive(role?: Role, search?: { q?: string; limit?: number }): Promise<TeamMemberEntity[]>;
}
