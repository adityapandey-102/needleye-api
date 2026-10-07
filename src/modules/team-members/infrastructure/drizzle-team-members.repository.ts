import { and, eq, ilike, type SQL } from "drizzle-orm";
import { containsPattern } from "../../../common/database/like-pattern";
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
  async findActive(role?: Role, search: { q?: string; limit?: number } = {}): Promise<TeamMemberEntity[]> {
    const conditions: SQL[] = [eq(profiles.active, true)];
    if (role) conditions.push(eq(profiles.role, role));
    if (search.q) conditions.push(ilike(profiles.fullName, containsPattern(search.q)));

    try {
      const query = db
        .select({ id: profiles.id, fullName: profiles.fullName, role: profiles.role })
        .from(profiles)
        .where(and(...conditions))
        .orderBy(profiles.fullName);
      return await (search.limit ? query.limit(search.limit) : query);
    } catch (error) {
      throw new InternalError("Failed to load team members", error);
    }
  }
}
