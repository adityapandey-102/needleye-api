import type { AuthSession } from "../../../../common/auth/auth-provider";
import type { Profile } from "../../../../domain";
import type { BootstrapDto } from "../../api/dto/bootstrap.dto";

export type { AuthSession as AuthTokens } from "../../../../common/auth/auth-provider";

/** Persistence contract for the Auth module -- pure data access, no business rules. */
export interface AuthRepositoryPort {
  countOwnerManagers(): Promise<number>;
  createOwnerManagerUser(dto: BootstrapDto): Promise<void>;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  refreshSession(refreshToken: string): Promise<AuthSession>;
  signOut(accessToken: string): Promise<void>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  updatePassword(userId: string, newPassword: string): Promise<void>;
  exchangeCodeForSession(code: string): Promise<AuthSession>;
  getProfile(userId: string): Promise<Profile>;
  signInWithQrToken(token: string): Promise<AuthSession>;
  recordLogin(userId: string): Promise<void>;
}
