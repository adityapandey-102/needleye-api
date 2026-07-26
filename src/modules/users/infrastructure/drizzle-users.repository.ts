import { eq, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { profiles } from "./profile.schema";
// Cross-module Infrastructure-only read/write: `qr_login_tokens` is owned by
// the Auth module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { qrLoginTokens } from "../../auth/infrastructure/qr-login.schema";
import { InternalError } from "../../../common/errors/app-error";
import { UserAccountMapper } from "./user-account.mapper";
import type { AuthProvider } from "../../../common/auth/auth-provider";
import type { Role } from "../../../domain";
import type { UserAccountEntity } from "../domain/user-account.entity";
import type { UsersRepositoryPort, ProfileUpdate } from "../application/ports/users-repository.port";
import type { UserAccountRow } from "./user-account.mapper";

const USER_ROW_SELECT = {
  id: profiles.id,
  full_name: profiles.fullName,
  email: profiles.email,
  role: profiles.role,
  active: profiles.active,
  created_at: sql<string>`${profiles.createdAt}`,
  last_login_at: sql<string | null>`${profiles.lastLoginAt}`,
  // One left join instead of a second round trip for every list/lookup --
  // has_qr_login is true whenever a qr_login_tokens row exists for this profile.
  has_qr_login: sql<boolean>`${qrLoginTokens.profileId} is not null`,
};

export class DrizzleUsersRepository implements UsersRepositoryPort {
  constructor(private readonly authProvider: AuthProvider) {}

  async findAll(): Promise<UserAccountEntity[]> {
    let rows: UserAccountRow[];
    try {
      rows = await db
        .select(USER_ROW_SELECT)
        .from(profiles)
        .leftJoin(qrLoginTokens, eq(qrLoginTokens.profileId, profiles.id))
        .orderBy(profiles.createdAt);
    } catch (error) {
      throw new InternalError("Failed to load users", error);
    }
    return rows.map((row) => UserAccountMapper.toEntity(row));
  }

  async findById(id: string): Promise<UserAccountEntity | null> {
    let rows: UserAccountRow[];
    try {
      rows = await db
        .select(USER_ROW_SELECT)
        .from(profiles)
        .leftJoin(qrLoginTokens, eq(qrLoginTokens.profileId, profiles.id))
        .where(eq(profiles.id, id))
        .limit(1);
    } catch (error) {
      throw new InternalError("Failed to load user", error);
    }
    const row = rows[0];
    return row ? UserAccountMapper.toEntity(row) : null;
  }

  async createUser(email: string, fullName: string, role: Role, password: string): Promise<string> {
    // No invite email -- the account is created with a real password
    // straight away; the Owner/Manager communicates it to the new hire
    // directly. handle_new_user() (a DB trigger, see supabase/migrations)
    // reads full_name/role from the new auth user's metadata and creates
    // the matching `profiles` row automatically -- nothing to insert here.
    return this.authProvider.createUser({ email, password, fullName, role });
  }

  async updateProfile(id: string, updates: ProfileUpdate): Promise<void> {
    const record: Partial<typeof profiles.$inferInsert> = {};
    if (updates.fullName !== undefined) record.fullName = updates.fullName;
    if (updates.role !== undefined) record.role = updates.role;
    if (updates.active !== undefined) record.active = updates.active;

    try {
      await db.update(profiles).set(record).where(eq(profiles.id, id));
    } catch (error) {
      throw new InternalError("Failed to update user", error);
    }
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.authProvider.setPassword(id, password);
  }

  async setQrToken(profileId: string, tokenHash: string): Promise<void> {
    try {
      await db
        .insert(qrLoginTokens)
        .values({ profileId, tokenHash })
        .onConflictDoUpdate({
          target: qrLoginTokens.profileId,
          set: { tokenHash, createdAt: new Date() },
        });
    } catch (error) {
      throw new InternalError("Failed to save QR login token", error);
    }
  }

  async clearQrToken(profileId: string): Promise<void> {
    try {
      await db.delete(qrLoginTokens).where(eq(qrLoginTokens.profileId, profileId));
    } catch (error) {
      throw new InternalError("Failed to clear QR login token", error);
    }
  }

  async banAuthUser(id: string): Promise<void> {
    await this.authProvider.banUser(id);
  }
}
