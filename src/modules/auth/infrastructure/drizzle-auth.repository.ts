import { eq, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
// Cross-module Infrastructure-only read/write: `profiles` is owned by the
// Users module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../users/infrastructure/profile.schema";
import { qrLoginTokens } from "./qr-login.schema";
import { fetchActiveProfile } from "../../../common/database/profiles";
import { hashToken } from "../../../common/crypto/credentials";
import { InternalError, UnauthorizedError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { AuthProvider, AuthSession } from "../../../common/auth/auth-provider";
import type { Profile } from "../../../domain";
import type { AuthRepositoryPort } from "../application/ports/auth-repository.port";
import type { BootstrapDto } from "../api/dto/bootstrap.dto";

/**
 * Persistence (profiles/qr_login_tokens, via Drizzle) + the Auth module's
 * use of AuthProvider -- this repository is the one place those two seams
 * meet for auth-specific concerns, same as DrizzleUsersRepository.
 */
export class DrizzleAuthRepository implements AuthRepositoryPort {
  constructor(private readonly authProvider: AuthProvider) {}

  async countOwnerManagers(): Promise<number> {
    let rows;
    try {
      rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(profiles)
        .where(eq(profiles.role, "owner_manager"));
    } catch (error) {
      throw new InternalError("Failed to check bootstrap status", error);
    }
    return rows[0]?.count ?? 0;
  }

  async createOwnerManagerUser(dto: BootstrapDto): Promise<void> {
    await this.authProvider.createUser({
      email: dto.email,
      password: dto.password,
      fullName: dto.fullName,
      role: "owner_manager",
    });
  }

  async signInWithPassword(email: string, password: string): Promise<AuthSession> {
    return this.authProvider.signInWithPassword(email, password);
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    return this.authProvider.refreshSession(refreshToken);
  }

  async signOut(accessToken: string): Promise<void> {
    await this.authProvider.signOut(accessToken);
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    // Never surfaces whether the email exists -- errors here are logged but not thrown,
    // so the API's response is identical either way.
    await this.authProvider.requestPasswordReset(email, redirectTo);
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    await this.authProvider.setPassword(userId, newPassword);
  }

  async exchangeCodeForSession(code: string): Promise<AuthSession> {
    return this.authProvider.exchangeCodeForSession(code);
  }

  async getProfile(userId: string): Promise<Profile> {
    return fetchActiveProfile(userId);
  }

  /**
   * Mints a real session for whichever profile owns this QR token, without
   * ever needing (or storing) their password. `qr_login_tokens` only ever
   * holds a hash (see the migration comment); the flow is: look up the
   * profile by hash -> ask AuthProvider to mint a session for that email.
   */
  async signInWithQrToken(token: string): Promise<AuthSession> {
    const tokenHash = hashToken(token);

    let qrRows;
    try {
      qrRows = await db.select({ profileId: qrLoginTokens.profileId }).from(qrLoginTokens).where(eq(qrLoginTokens.tokenHash, tokenHash)).limit(1);
    } catch (error) {
      throw new InternalError("Failed to verify QR login token", error);
    }
    const qrRow = qrRows[0];
    if (!qrRow) throw new UnauthorizedError("Invalid or expired QR code", ERROR_CODES.AUTH_QR_INVALID);

    let profileRows;
    try {
      profileRows = await db
        .select({ email: profiles.email, active: profiles.active })
        .from(profiles)
        .where(eq(profiles.id, qrRow.profileId))
        .limit(1);
    } catch (error) {
      throw new InternalError("Failed to verify QR login token", error);
    }
    const profileRow = profileRows[0];
    if (!profileRow || !profileRow.active) throw new UnauthorizedError("Invalid or expired QR code", ERROR_CODES.AUTH_QR_INVALID);

    return this.authProvider.mintSessionForUser(profileRow.email);
  }

  async recordLogin(userId: string): Promise<void> {
    try {
      await db.update(profiles).set({ lastLoginAt: new Date() }).where(eq(profiles.id, userId));
    } catch (error) {
      throw new InternalError("Failed to record login", error);
    }
  }
}
