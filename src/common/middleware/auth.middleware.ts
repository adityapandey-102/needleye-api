import type { Request, Response, NextFunction } from "express";
import type { Profile } from "../../domain";
import { authProvider } from "../auth/supabase-auth-provider";
import { fetchActiveProfile } from "../database/profiles";
import { asyncHandler } from "../http/async-handler";
import { UnauthorizedError } from "../errors/app-error";
import { ERROR_CODES } from "../errors/error-codes";
import { setRequestUser } from "../context/request-context";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUserId?: string;
      accessToken?: string;
      profile?: Profile;
    }
  }
}

/**
 * Verifies the bearer token via AuthProvider, then loads the matching
 * `profiles` row (role, active) via Drizzle. `profiles.role` is the
 * authorization source of truth -- not client-writable JWT metadata.
 * Nothing here is stored between requests: every call re-verifies the token
 * it was given, which is what keeps the API stateless. Never touches the
 * Supabase SDK directly -- that's entirely inside SupabaseAuthProvider.
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) throw new UnauthorizedError("Missing bearer token", ERROR_CODES.AUTH_TOKEN_MISSING);

  const verified = await authProvider.verifyAccessToken(token);
  if (!verified) throw new UnauthorizedError("Invalid or expired session", ERROR_CODES.AUTH_SESSION_INVALID);

  req.authUserId = verified.userId;
  req.accessToken = token;
  req.profile = await fetchActiveProfile(verified.userId);

  // Make the authenticated identity available to request-scoped consumers
  // that don't have `req` (audit logger, slow-query logger).
  setRequestUser(req.profile.id, req.profile.role);

  next();
});
