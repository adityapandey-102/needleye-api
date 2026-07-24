import type { Role } from "../../domain";

/** A live session, whatever issued it. */
export interface AuthSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface NewAuthUser {
  email: string;
  password: string;
  fullName: string;
  role: Role;
}

/**
 * Everything the application needs from an identity provider, named around
 * what the business does ("sign in", "mint a session for this user")
 * rather than around Supabase Auth's specific API shape. Business services
 * depend on this interface only -- see SupabaseAuthProvider for the one
 * concrete implementation today. Swapping to Clerk/Auth0/Keycloak/Cognito/a
 * custom JWT scheme later means writing one new class satisfying this
 * interface; nothing in modules/* changes.
 *
 * Deliberately does NOT expose Supabase-specific primitives like
 * `generateLink`/`verifyOtp` individually -- `mintSessionForUser` wraps
 * whatever two-step dance a given provider needs behind one method, so the
 * caller (AuthRepository's QR-login path) never learns the provider's
 * internal mechanics.
 */
export interface AuthProvider {
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  refreshSession(refreshToken: string): Promise<AuthSession>;
  /** Revokes the session server-side -- best-effort; an already-invalid token is not an error. */
  signOut(accessToken: string): Promise<void>;
  /** Verifies an access token and returns the user id it belongs to, or null if invalid/expired. */
  verifyAccessToken(token: string): Promise<{ userId: string } | null>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  /** Admin-level: sets a user's password directly, no old-password check (used for both self-update and Owner/Manager-issued resets). */
  setPassword(userId: string, newPassword: string): Promise<void>;
  exchangeCodeForSession(code: string): Promise<AuthSession>;
  /** Mints a real session for a user with no password check at all -- backs QR login. Never emails anything. */
  mintSessionForUser(email: string): Promise<AuthSession>;
  createUser(user: NewAuthUser): Promise<string>;
  banUser(userId: string): Promise<void>;
}
