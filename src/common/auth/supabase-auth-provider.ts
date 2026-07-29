import { supabaseClient, supabaseAuthClient } from "../database/supabase-client";
import { BadRequestError, InternalError, UnauthorizedError } from "../errors/app-error";
import { ERROR_CODES } from "../errors/error-codes";
import type { AuthProvider, AuthSession, NewAuthUser } from "./auth-provider";

function toAuthSession(session: {
  user: { id: string };
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}): AuthSession {
  return {
    userId: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? 0,
  };
}

/**
 * The only file in this codebase (besides SupabaseStorageProvider) allowed
 * to import the Supabase Auth clients directly -- every other module talks
 * to AuthProvider. Two clients purely because Supabase itself splits the
 * privilege levels: `supabaseAuthClient` (anon key) for what a public
 * client would do (sign in, refresh, reset, exchange, redeem a magic
 * link); `supabaseClient` (service-role) for admin-only operations (create
 * user, force-set a password, ban, mint a magic link for someone else).
 */
export class SupabaseAuthProvider implements AuthProvider {
  async signInWithPassword(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await supabaseAuthClient.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new UnauthorizedError("Invalid email or password", ERROR_CODES.AUTH_INVALID_CREDENTIALS);
    return toAuthSession(data.session);
  }

  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const { data, error } = await supabaseAuthClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) throw new UnauthorizedError("Invalid or expired session", ERROR_CODES.AUTH_SESSION_INVALID);
    return toAuthSession(data.session);
  }

  async signOut(accessToken: string): Promise<void> {
    await supabaseClient.auth.admin.signOut(accessToken, "global").catch(() => {
      // Best-effort: a token that's already invalid/expired is not an error.
    });
  }

  async verifyAccessToken(token: string): Promise<{ userId: string } | null> {
    const { data, error } = await supabaseClient.auth.getUser(token);
    if (error || !data.user) return null;
    return { userId: data.user.id };
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    // Never surfaces whether the email exists -- errors here are logged but not thrown,
    // so the API's response is identical either way.
    await supabaseAuthClient.auth.resetPasswordForEmail(email, { redirectTo });
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const { error } = await supabaseClient.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) throw new BadRequestError(error.message);
  }

  async exchangeCodeForSession(code: string): Promise<AuthSession> {
    const { data, error } = await supabaseAuthClient.auth.exchangeCodeForSession(code);
    if (error || !data.session) throw new UnauthorizedError("Invalid or expired link", ERROR_CODES.AUTH_LINK_INVALID);
    return toAuthSession(data.session);
  }

  /**
   * generateLink + verifyOtp is Supabase's own two-step mechanic for
   * minting a session with no password check -- generateLink is admin-only
   * and never actually sends anything, verifyOtp immediately redeems it
   * server-side. Callers only ever see "give me a session for this email."
   */
  async mintSessionForUser(email: string): Promise<AuthSession> {
    const { data: linkData, error: linkError } = await supabaseClient.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError || !linkData.properties?.hashed_token) {
      throw new InternalError("Failed to establish a session for this account");
    }

    const { data: sessionData, error: sessionError } = await supabaseAuthClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    if (sessionError || !sessionData.session) {
      throw new InternalError("Failed to establish a session for this account");
    }

    return toAuthSession(sessionData.session);
  }

  async createUser(user: NewAuthUser): Promise<string> {
    const { data, error } = await supabaseClient.auth.admin.createUser({
      email: user.email,
      password: user.password,
      email_confirm: true,
      user_metadata: { full_name: user.fullName, role: user.role },
    });
    if (error) throw new BadRequestError(error.message);
    return data.user.id;
  }

  async banUser(userId: string): Promise<void> {
    // Blocks sign-in at the Auth layer, not just app-level gating.
    const { error } = await supabaseClient.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
    if (error) throw new InternalError("Failed to revoke account access");
  }
}

/** Module-level singleton -- manual composition root, no DI container needed at this size. Mirrors storageProvider's pattern. */
export const authProvider: AuthProvider = new SupabaseAuthProvider();
