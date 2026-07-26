import { and, eq } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
// Cross-module Infrastructure-only read: `profiles` is owned by the Users
// module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../users/infrastructure/profile.schema";
import { InternalError } from "../../../common/errors/app-error";
import type { Role } from "../../../domain";
import type { TeamMemberEntity } from "../domain/team-member.entity";
import type { TeamMembersRepositoryPort } from "../application/ports/team-members-repository.port";

/**
 * No mapper file for this module: the select below already projects
 * directly into TeamMemberEntity's shape (no joins, no row-format
 * translation needed) -- adding a pass-through mapper class here would be
 * ceremony with no behavior, the same "don't force it" principle as the
 * empty domain layer.
 */
export class DrizzleTeamMembersRepository implements TeamMembersRepositoryPort {
  async findActive(role?: Role): Promise<TeamMemberEntity[]> {
    const condition = role ? and(eq(profiles.active, true), eq(profiles.role, role)) : eq(profiles.active, true);

    try {
      return await db
        .select({ id: profiles.id, fullName: profiles.fullName, role: profiles.role })
        .from(profiles)
        .where(condition)
        .orderBy(profiles.fullName);
    } catch (error) {
      throw new InternalError("Failed to load team members", error);
    }
  }
}
